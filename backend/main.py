"""
Xmas Showdown API
Lobby-focused FastAPI app for guest presence.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.api.v1.routers import api_router

app = FastAPI(
    title="Xmas Showdown API",
    description="Lobby API for Gifts Under Siege.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix="/api/v1")


@app.get("/", tags=["Root"])
async def read_root():
    return {"message": "Xmas Showdown lobby is running."}
