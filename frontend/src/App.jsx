import { useEffect, useMemo, useRef, useState } from 'react';

const STATUS_LABELS = {
  connected: 'Connected',
  connecting: 'Connecting',
  disconnected: 'Disconnected',
  error: 'Error',
};

const STATUS_HINTS = {
  connected: 'You are in the lobby.',
  connecting: 'Reaching the lobby...',
  disconnected: 'Lobby connection is closed. Sign in again for a fresh token.',
  error: 'Something went wrong with the lobby connection.',
};

const MEMBER_STATUS_LABELS = {
  in_lobby: 'In lobby',
  in_room: 'Connected',
  in_game: 'Connected',
  disconnected: 'Disconnected',
};

const MEMBER_STATUS_ORDER = {
  in_game: 0,
  in_room: 1,
  in_lobby: 2,
  disconnected: 3,
};

const clamp = (value, min = 0, max = 100) => Math.min(max, Math.max(min, value));

const hashString = (value) => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
};

const createPlayerStats = (memberId) => {
  const seed = hashString(memberId || 'seed');
  return {
    energy: clamp(45 + (seed % 40)),
    focus: clamp(35 + ((seed >> 3) % 45)),
    ready: false,
    lastActionAt: 0,
  };
};

const createGameState = (room) => {
  const players = {};
  room.members.forEach((member) => {
    players[member.member_id] = {
      name: member.name,
      ...createPlayerStats(member.member_id),
    };
  });
  return {
    roomId: room.room_id,
    activity: 40,
    pulseCount: 0,
    lastPulseAt: 0,
    lastEvent: '',
    lastEventAt: 0,
    players,
  };
};

const syncGameState = (state, room) => {
  const nextPlayers = { ...state.players };
  room.members.forEach((member) => {
    const existing = nextPlayers[member.member_id];
    nextPlayers[member.member_id] = {
      ...(existing || createPlayerStats(member.member_id)),
      name: member.name,
    };
  });
  Object.keys(nextPlayers).forEach((memberId) => {
    if (!room.members.some((member) => member.member_id === memberId)) {
      delete nextPlayers[memberId];
    }
  });
  return { ...state, players: nextPlayers };
};

const buildWsBase = () => {
  if (process.env.REACT_APP_WS_BASE) {
    return process.env.REACT_APP_WS_BASE;
  }
  const { protocol, hostname, port } = window.location;
  const wsProtocol = protocol === 'https:' ? 'wss' : 'ws';
  if (process.env.NODE_ENV === 'development') {
    return `${wsProtocol}://${hostname}:8000`;
  }
  const portSuffix = port ? `:${port}` : '';
  return `${wsProtocol}://${hostname}${portSuffix}`;
};

const formatJoinedTime = (value) => {
  if (!value) return '';
  const date = new Date(value);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const formatExpiryTime = (value) => {
  if (!value) return '';
  const date = new Date(value);
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const summarizeToken = (token) => {
  if (!token) return '';
  if (token.length <= 12) return token;
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
};

export default function App() {
  const [status, setStatus] = useState('disconnected');
  const [members, setMembers] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [me, setMe] = useState(null);
  const [nameInput, setNameInput] = useState('');
  const [authToken, setAuthToken] = useState(null);
  const [authExpiresAt, setAuthExpiresAt] = useState(null);
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [roomNameInput, setRoomNameInput] = useState('');
  const [roomError, setRoomError] = useState('');
  const [knownMembers, setKnownMembers] = useState({});
  const [roomHistory, setRoomHistory] = useState({});
  const [gameStates, setGameStates] = useState({});
  const [tick, setTick] = useState(0);
  const wsRef = useRef(null);

  const sendMessage = (payload) => {
    if (status !== 'connected' || !wsRef.current) {
      return false;
    }
    wsRef.current.send(JSON.stringify(payload));
    return true;
  };

  const upsertKnownMembers = (incoming) => {
    setKnownMembers((prev) => {
      const updated = { ...prev };
      (incoming || []).forEach((member) => {
        updated[member.member_id] = {
          ...updated[member.member_id],
          ...member,
          lastSeenAt: Date.now(),
        };
      });
      return updated;
    });
  };

  const markMemberDisconnected = (member) => {
    if (!member) {
      return;
    }
    setKnownMembers((prev) => {
      const updated = { ...prev };
      updated[member.member_id] = {
        ...updated[member.member_id],
        ...member,
        lastSeenAt: Date.now(),
      };
      return updated;
    });
  };

  const connect = (desiredName, token) => {
    if (!token) {
      setAuthError('Guest token missing. Please sign in again.');
      return;
    }
    if (wsRef.current) {
      wsRef.current.close();
    }

    const params = new URLSearchParams();
    if (desiredName) {
      params.set('name', desiredName);
    }
    params.set('token', token);
    const wsUrl = `${buildWsBase()}/api/v1/lobby/ws?${params.toString()}`;
    const socket = new WebSocket(wsUrl);
    wsRef.current = socket;
    setStatus('connecting');

    const isActiveSocket = () => wsRef.current === socket;

    socket.onopen = () => {
      if (isActiveSocket()) {
        setStatus('connected');
      }
    };

    socket.onerror = () => {
      if (isActiveSocket()) {
        setStatus('error');
      }
    };

    socket.onclose = () => {
      if (isActiveSocket()) {
        setStatus('disconnected');
        setRooms([]);
        setMembers([]);
        setMe(null);
        setKnownMembers({});
        setRoomHistory({});
        setGameStates({});
        setAuthToken(null);
        setAuthExpiresAt(null);
      }
    };

    socket.onmessage = (event) => {
      if (!isActiveSocket()) {
        return;
      }
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch (err) {
        return;
      }

      if (payload.type === 'welcome') {
        setMe(payload.member);
        const incomingMembers = payload.members || [];
        setMembers(incomingMembers);
        setRooms(payload.rooms || []);
        setNameInput(payload.member?.name || '');
        setRoomError('');
        setKnownMembers(() => {
          const next = {};
          incomingMembers.forEach((member) => {
            next[member.member_id] = { ...member, lastSeenAt: Date.now() };
          });
          return next;
        });
        return;
      }

      if (payload.type === 'member_joined') {
        setMembers((prev) => {
          if (prev.find((item) => item.member_id === payload.member.member_id)) {
            return prev;
          }
          return [...prev, payload.member];
        });
        upsertKnownMembers([payload.member]);
      }

      if (payload.type === 'member_left') {
        setMembers((prev) => prev.filter((item) => item.member_id !== payload.member.member_id));
        markMemberDisconnected(payload.member);
      }

      if (payload.type === 'member_renamed') {
        setMembers((prev) =>
          prev.map((item) => (item.member_id === payload.member.member_id ? payload.member : item))
        );
        setMe((current) =>
          current && current.member_id === payload.member.member_id ? payload.member : current
        );
        upsertKnownMembers([payload.member]);
      }

      if (payload.type === 'rooms_updated') {
        setRooms(payload.rooms || []);
      }

      if (payload.type === 'error') {
        setRoomError(payload.message || 'Something went wrong.');
      }
    };
  };

  const requestGuestToken = async (desiredName) => {
    setAuthLoading(true);
    setAuthError('');
    try {
      const response = await fetch('/api/v1/auth/guest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: desiredName || null }),
      });
      if (!response.ok) {
        throw new Error('Failed to create guest token.');
      }
      const payload = await response.json();
      setAuthToken(payload.token);
      setAuthExpiresAt(payload.expires_at);
      if (payload.name) {
        setNameInput(payload.name);
      }
      return payload;
    } catch (error) {
      setAuthError('Unable to create guest token. Try again.');
      return null;
    } finally {
      setAuthLoading(false);
    }
  };

  const currentRoom = useMemo(
    () =>
      me
        ? rooms.find((room) => room.members?.some((member) => member.member_id === me.member_id))
        : null,
    [rooms, me]
  );
  const isHost = currentRoom && me && currentRoom.host_id === me.member_id;

  useEffect(() => {
    if (!me) {
      return;
    }
    const roomWithMe = rooms.find((room) =>
      room.members?.some((member) => member.member_id === me.member_id)
    );
    if (roomWithMe) {
      setRoomHistory((prev) => ({ ...prev, [roomWithMe.room_id]: true }));
    }
  }, [rooms, me]);

  useEffect(() => {
    if (!currentRoom || !currentRoom.started) {
      return;
    }
    setGameStates((prev) => {
      const existing = prev[currentRoom.room_id] || createGameState(currentRoom);
      const synced = syncGameState(existing, currentRoom);
      return { ...prev, [currentRoom.room_id]: synced };
    });
  }, [currentRoom]);

  useEffect(() => {
    if (!currentRoom || !currentRoom.started) {
      return;
    }
    const interval = setInterval(() => {
      setGameStates((prev) => {
        const state = prev[currentRoom.room_id];
        if (!state) {
          return prev;
        }
        const players = Object.fromEntries(
          Object.entries(state.players).map(([memberId, player]) => [
            memberId,
            {
              ...player,
              energy: clamp(player.energy - 1),
              focus: clamp(player.focus - 1),
            },
          ])
        );
        return {
          ...prev,
          [currentRoom.room_id]: {
            ...state,
            players,
            activity: clamp(state.activity - 1),
          },
        };
      });
      setTick((value) => value + 1);
    }, 3000);
    return () => clearInterval(interval);
  }, [currentRoom?.room_id, currentRoom?.started]);

  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  const handleNameSubmit = async (event) => {
    event.preventDefault();
    if (status === 'connected' && wsRef.current) {
      wsRef.current.send(
        JSON.stringify({
          type: 'rename',
          name: nameInput.trim(),
        })
      );
      return;
    }
    const payload = await requestGuestToken(nameInput.trim());
    if (!payload) {
      return;
    }
    connect(payload.name, payload.token);
  };

  const handleReconnect = async () => {
    const payload = await requestGuestToken(nameInput.trim());
    if (!payload) {
      return;
    }
    connect(payload.name, payload.token);
  };

  const handleCreateRoom = (event) => {
    event.preventDefault();
    if (!sendMessage({ type: 'create_room', name: roomNameInput.trim() })) {
      return;
    }
    setRoomNameInput('');
    setRoomError('');
  };

  const handleJoinRoom = (roomId) => {
    sendMessage({ type: 'join_room', room_id: roomId });
    setRoomError('');
  };

  const handleLeaveRoom = () => {
    sendMessage({ type: 'leave_room' });
    setRoomError('');
  };

  const handleStartGame = (roomId) => {
    sendMessage({ type: 'start_game', room_id: roomId });
    setRoomError('');
  };

  const updateGameState = (roomId, updater) => {
    setGameStates((prev) => {
      const current = prev[roomId];
      if (!current) {
        return prev;
      }
      const updated = updater(current);
      return { ...prev, [roomId]: updated };
    });
  };

  const handleBoostSelf = () => {
    if (!currentRoom || !me) {
      return;
    }
    const now = Date.now();
    updateGameState(currentRoom.room_id, (state) => {
      const player = state.players[me.member_id];
      if (!player) {
        return state;
      }
      return {
        ...state,
        activity: clamp(state.activity + 6),
        lastEvent: `${player.name} boosted energy.`,
        lastEventAt: now,
        players: {
          ...state.players,
          [me.member_id]: {
            ...player,
            energy: clamp(player.energy + 12),
            lastActionAt: now,
          },
        },
      };
    });
  };

  const handleFocusSelf = () => {
    if (!currentRoom || !me) {
      return;
    }
    const now = Date.now();
    updateGameState(currentRoom.room_id, (state) => {
      const player = state.players[me.member_id];
      if (!player) {
        return state;
      }
      return {
        ...state,
        activity: clamp(state.activity + 5),
        lastEvent: `${player.name} sharpened focus.`,
        lastEventAt: now,
        players: {
          ...state.players,
          [me.member_id]: {
            ...player,
            focus: clamp(player.focus + 12),
            lastActionAt: now,
          },
        },
      };
    });
  };

  const handleToggleReady = () => {
    if (!currentRoom || !me) {
      return;
    }
    const now = Date.now();
    updateGameState(currentRoom.room_id, (state) => {
      const player = state.players[me.member_id];
      if (!player) {
        return state;
      }
      const ready = !player.ready;
      return {
        ...state,
        activity: clamp(state.activity + 4),
        lastEvent: `${player.name} is ${ready ? 'ready' : 'not ready'}.`,
        lastEventAt: now,
        players: {
          ...state.players,
          [me.member_id]: {
            ...player,
            ready,
            lastActionAt: now,
          },
        },
      };
    });
  };

  const handlePulseRoom = () => {
    if (!currentRoom) {
      return;
    }
    const now = Date.now();
    updateGameState(currentRoom.room_id, (state) => {
      const players = Object.fromEntries(
        Object.entries(state.players).map(([memberId, player]) => [
          memberId,
          {
            ...player,
            energy: clamp(player.energy + 4),
            lastActionAt: now,
          },
        ])
      );
      return {
        ...state,
        activity: clamp(state.activity + 10),
        pulseCount: state.pulseCount + 1,
        lastPulseAt: now,
        lastEvent: 'Room pulse sent.',
        lastEventAt: now,
        players,
      };
    });
  };

  const handleBoostPlayer = (memberId) => {
    if (!currentRoom) {
      return;
    }
    const now = Date.now();
    updateGameState(currentRoom.room_id, (state) => {
      const player = state.players[memberId];
      if (!player) {
        return state;
      }
      return {
        ...state,
        activity: clamp(state.activity + 4),
        lastEvent: `${player.name} received a boost.`,
        lastEventAt: now,
        players: {
          ...state.players,
          [memberId]: {
            ...player,
            energy: clamp(player.energy + 8),
            lastActionAt: now,
          },
        },
      };
    });
  };

  const roomRoster = useMemo(() => {
    const map = new Map();
    rooms.forEach((room) => {
      (room.members || []).forEach((member) => {
        map.set(member.member_id, { roomId: room.room_id, roomName: room.name, started: room.started });
      });
    });
    return map;
  }, [rooms]);

  const memberStatusList = useMemo(() => {
    const connectedIds = new Set(members.map((member) => member.member_id));
    const list = Object.values(knownMembers).map((member) => {
      if (!connectedIds.has(member.member_id)) {
        return {
          ...member,
          status: 'disconnected',
          room: null,
        };
      }
      const roomInfo = roomRoster.get(member.member_id);
      if (roomInfo) {
        return {
          ...member,
          status: roomInfo.started ? 'in_game' : 'in_room',
          room: roomInfo,
        };
      }
      return {
        ...member,
        status: 'in_lobby',
        room: null,
      };
    });
    return list.sort((left, right) => {
      const orderLeft = MEMBER_STATUS_ORDER[left.status] ?? 9;
      const orderRight = MEMBER_STATUS_ORDER[right.status] ?? 9;
      if (orderLeft !== orderRight) {
        return orderLeft - orderRight;
      }
      return left.name.localeCompare(right.name);
    });
  }, [members, knownMembers, roomRoster, tick]);

  const currentGame =
    currentRoom && currentRoom.started ? gameStates[currentRoom.room_id] : null;

  if (currentRoom && currentRoom.started) {
    if (!currentGame) {
      return (
        <div className="page">
          <div className="shell game-shell">
            <section className="panel game-panel">
              <div className="panel-header">
                <div>
                  <h2>Room session</h2>
                  <p className="muted">
                    {currentRoom.name} · Room #{currentRoom.room_id}
                  </p>
                </div>
                <div className="game-header-actions">
                  <div className="count-pill">In game</div>
                  <button type="button" className="ghost" onClick={handleLeaveRoom}>
                    Leave room
                  </button>
                </div>
              </div>
              <div className="panel-body">
                <div className="empty-state">
                  <p>Preparing the room state...</p>
                </div>
              </div>
            </section>
          </div>
        </div>
      );
    }

    const now = Date.now();
    const connectedIds = new Set(members.map((member) => member.member_id));
    const players = Object.entries(currentGame.players)
      .map(([memberId, data]) => ({
        memberId,
        ...data,
        isConnected: connectedIds.has(memberId),
        isMe: me && me.member_id === memberId,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const meState = me ? currentGame.players[me.member_id] : null;
    const activityPulse = now - currentGame.lastPulseAt < 900;
    const recentEvent =
      currentGame.lastEvent && now - currentGame.lastEventAt < 6000;

    const renderStat = (label, value) => (
      <div className="stat-row">
        <span className="stat-label">{label}</span>
        <div className="stat-bar">
          <span className="stat-fill" style={{ width: `${value}%` }} />
        </div>
        <span className="stat-value">{value}%</span>
      </div>
    );

    return (
      <div className="page">
        <div className="shell game-shell">
          <section className="panel game-panel">
            <div className="panel-header">
              <div>
                <h2>Room session</h2>
                <p className="muted">
                  {currentRoom.name} · Room #{currentRoom.room_id}
                </p>
              </div>
              <div className="game-header-actions">
                <div className="count-pill">In game</div>
                <button type="button" className="ghost" onClick={handleLeaveRoom}>
                  Leave room
                </button>
              </div>
            </div>
            <div className="panel-body game-layout">
              <aside className="side-panel">
                <h3>Players</h3>
                <ul className="player-list">
                  {players.map((player) => {
                    const pulse = now - player.lastActionAt < 900;
                    return (
                      <li
                        key={player.memberId}
                        className={`player-card ${
                          player.isMe ? 'player-card--me' : ''
                        } ${player.ready ? 'player-card--ready' : ''} ${
                          pulse ? 'player-card--pulse' : ''
                        }`}
                      >
                        <div className="player-name">
                          {player.name}
                          {player.isMe ? <span className="you-tag">You</span> : null}
                          <span
                            className={`status-tag status-tag--${
                              player.isConnected ? 'connected' : 'disconnected'
                            }`}
                          >
                            {player.isConnected ? 'Connected' : 'Disconnected'}
                          </span>
                        </div>
                        <div className="player-meta">
                          {player.ready ? 'Ready' : 'Waiting'}
                        </div>
                        <div className="stat-stack">
                          {renderStat('Energy', player.energy)}
                          {renderStat('Focus', player.focus)}
                        </div>
                        {!player.isMe ? (
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => handleBoostPlayer(player.memberId)}
                          >
                            Send boost
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </aside>
              <div className="game-main">
                <div className="game-section activity-card">
                  <h3>Room activity</h3>
                  <div
                    className={`activity-meter ${
                      activityPulse ? 'activity-meter--pulse' : ''
                    }`}
                  >
                    <span
                      className="activity-meter__bar"
                      style={{ width: `${currentGame.activity}%` }}
                    />
                  </div>
                  <div className="activity-meta">
                    Activity {currentGame.activity}% · Pulses {currentGame.pulseCount}
                  </div>
                  <div className="room-event">
                    {recentEvent ? currentGame.lastEvent : 'No recent activity.'}
                  </div>
                </div>
                <div className="game-section controls-card">
                  <h3>Your controls</h3>
                  <div className="controls-grid">
                    <button type="button" className="primary" onClick={handleBoostSelf}>
                      Boost energy
                    </button>
                    <button type="button" className="ghost" onClick={handleFocusSelf}>
                      Sharpen focus
                    </button>
                    <button type="button" className="ghost" onClick={handlePulseRoom}>
                      Pulse room
                    </button>
                    <button type="button" className="ghost" onClick={handleToggleReady}>
                      {meState && meState.ready ? 'Set not ready' : 'Set ready'}
                    </button>
                  </div>
                  <p className="muted">
                    These controls update a lightweight simulation of the room.
                  </p>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    );
  }

  const membersCount = members.length;
  const statusLabel = STATUS_LABELS[status] || STATUS_LABELS.disconnected;
  const statusHint = STATUS_HINTS[status] || STATUS_HINTS.disconnected;
  const tokenDisplay = summarizeToken(authToken);
  const tokenExpiry = formatExpiryTime(authExpiresAt);

  return (
    <div className="page">
      <div className="shell">
        <section className="hero">
          <p className="eyebrow">Live Lobby</p>
          <h1>Player Lobby</h1>
          <p className="lede">
            Create a guest session, join a room, and keep track of who is connected.
          </p>
          <div className="hero-grid">
            <div className="hero-card">
              <h2>Guest access</h2>
              <p className="muted">
                Sign in as a guest to receive a 24-hour session token, then join the lobby.
              </p>
              <form className="name-form" onSubmit={handleNameSubmit}>
                <label className="field">
                  Display name
                  <input
                    type="text"
                    value={nameInput}
                    onChange={(event) => setNameInput(event.target.value)}
                    placeholder="Display name"
                    maxLength={24}
                  />
                </label>
                <div className="actions">
                  <button type="submit" className="primary" disabled={authLoading}>
                    {status === 'connected'
                      ? 'Update name'
                      : authLoading
                        ? 'Signing in...'
                        : 'Join lobby'}
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={handleReconnect}
                    disabled={authLoading}
                  >
                    Reconnect
                  </button>
                </div>
              </form>
              <div className="status-row">
                <span className={`status-pill status-pill--${status}`}>{statusLabel}</span>
                <span className="status-hint">{statusHint}</span>
              </div>
              {authError ? <div className="auth-error">{authError}</div> : null}
              {authToken ? (
                <div className="session-card">
                  <div className="session-label">Session token</div>
                  <div className="session-token">{tokenDisplay}</div>
                  <div className="muted">
                    Valid until {tokenExpiry || 'unknown'} or until you disconnect.
                  </div>
                </div>
              ) : null}
            </div>
            <div className="hero-card hero-card--rules">
              <h2>Lobby tips</h2>
              <ul>
                <li>Keep your display name short and easy to read.</li>
                <li>Create a room and share the code with your friends.</li>
                <li>Stay connected to hold your seat in the room.</li>
              </ul>
            </div>
          </div>
        </section>

        <section className="panel panel--rooms">
          <div className="panel-header">
            <div>
              <h2>Rooms</h2>
              <p className="muted">Create a room or join one already waiting.</p>
            </div>
            {currentRoom ? (
              <div className="count-pill">In room #{currentRoom.room_id}</div>
            ) : (
              <div className="count-pill">No room</div>
            )}
          </div>
          <div className="panel-body">
            <form className="room-form" onSubmit={handleCreateRoom}>
              <label className="field">
                Room name
                <input
                  type="text"
                  value={roomNameInput}
                  onChange={(event) => setRoomNameInput(event.target.value)}
                  placeholder="Strategy Room"
                  maxLength={32}
                />
              </label>
              <button type="submit" className="primary">
                Create room
              </button>
            </form>
            {roomError ? <div className="room-error">{roomError}</div> : null}
            {rooms.length === 0 ? (
              <div className="empty-state">
                <p>No rooms yet. Create one to start gathering players.</p>
              </div>
            ) : (
              <ul className="room-list">
                {rooms.map((room) => {
                  const inRoom = currentRoom && currentRoom.room_id === room.room_id;
                  const wasHere = roomHistory[room.room_id];
                  const canStart = inRoom && isHost && !room.started;
                  const joinLabel = wasHere
                    ? 'Reconnect'
                    : room.started
                      ? 'Join game'
                      : 'Join room';
                  return (
                    <li key={room.room_id} className={`room ${inRoom ? 'room--active' : ''}`}>
                      <div className="room-top">
                        <div>
                          <div className="room-name">{room.name}</div>
                          <div className="room-meta">
                            Host: {room.host_name || '—'} · {room.members.length} players ·{' '}
                            {room.started ? 'In game' : 'Waiting'}
                          </div>
                        </div>
                        <div className="room-code">#{room.room_id}</div>
                      </div>
                      <div className="room-members">
                        {room.members.map((member) => (
                          <span
                            key={member.member_id}
                            className={`pill ${
                              member.member_id === room.host_id ? 'pill--host' : ''
                            } ${me && member.member_id === me.member_id ? 'pill--me' : ''}`}
                          >
                            {member.name}
                          </span>
                        ))}
                      </div>
                      <div className="room-actions">
                        {inRoom ? (
                          <>
                            {canStart ? (
                              <button
                                type="button"
                                className="primary"
                                onClick={() => handleStartGame(room.room_id)}
                              >
                                Start game
                              </button>
                            ) : null}
                            <button type="button" className="ghost" onClick={handleLeaveRoom}>
                              Leave room
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="primary"
                            onClick={() => handleJoinRoom(room.room_id)}
                          >
                            {joinLabel}
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div className="panel-footer">
            <div>
              <p className="muted">Room status</p>
              <p className="status-line">
                {currentRoom
                  ? `${currentRoom.name} is ${currentRoom.started ? 'in game' : 'waiting'}`
                  : 'You are not in a room yet.'}
              </p>
            </div>
            <div className="signal-bar">
              <span />
              <span />
              <span />
              <span />
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Players</h2>
              <p className="muted">Current connections and recent activity.</p>
            </div>
            <div className="count-pill">{membersCount} online</div>
          </div>
          <div className="panel-body">
            {memberStatusList.length === 0 ? (
              <div className="empty-state">
                <p>No players yet. Keep this tab open to hold the lobby.</p>
              </div>
            ) : (
              <ul className="member-list">
                {memberStatusList.map((member) => (
                  <li key={member.member_id} className="member">
                    <div>
                      <div className="member-name">
                        {member.name}
                        {me && me.member_id === member.member_id ? (
                          <span className="you-tag">You</span>
                        ) : null}
                      </div>
                      <div className="member-meta">
                        <span className={`status-tag status-tag--${member.status}`}>
                          {MEMBER_STATUS_LABELS[member.status] || 'Unknown'}
                        </span>
                        {member.room ? ` · Room #${member.room.roomId}` : ''}
                        {member.room && member.room.started ? ' · In game' : ''}
                        {member.status === 'disconnected' && member.lastSeenAt
                          ? ` · Last seen ${formatJoinedTime(member.lastSeenAt)}`
                          : ` · Joined at ${formatJoinedTime(member.joined_at)}`}
                      </div>
                    </div>
                    <div className="member-id">#{member.member_id.slice(0, 6)}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="panel-footer">
            <div>
              <p className="muted">Lobby status</p>
              <p className="status-line">
                {me ? `${me.name} is waiting in the lobby.` : 'Connecting...'}
              </p>
            </div>
            <div className="signal-bar">
              <span />
              <span />
              <span />
              <span />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
