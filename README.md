# Geodesic

## Docker setup

Production:

- `docker compose up --build`
- Open `http://localhost:3000`

Development (auto-reload):

- `docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build`
- Frontend: `http://localhost:3000`
- Backend: `http://localhost:8000`
