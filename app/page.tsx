"use client";

import { useState, useCallback } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

function generateUserId(): string {
  return `user_${Math.random().toString(36).substring(2, 11)}`;
}

function generateRoomCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function getUserId(): string {
  if (typeof window === "undefined") return generateUserId();
  const stored = localStorage.getItem("kingscup_user_id");
  if (stored) return stored;
  const newId = generateUserId();
  localStorage.setItem("kingscup_user_id", newId);
  return newId;
}

export default function HomePage() {
  const [playerName, setPlayerName] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const createRoom = useMutation(api.room.createRoom);
  const joinRoom = useMutation(api.room.joinRoom);

  const handleCreateRoom = useCallback(async () => {
    if (!playerName.trim()) {
      setError("Please enter your name first");
      return;
    }

    setError(null);
    setIsLoading(true);

    try {
      const userId = getUserId();
      const newRoomCode = generateRoomCode();

      await createRoom({
        userId,
        roomId: newRoomCode,
        playerName: playerName.trim(),
      });

      // Navigate to the room lobby
      window.location.href = `/room/${newRoomCode}?name=${encodeURIComponent(playerName.trim())}`;
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to create room";
      setError(errorMessage);
    } finally {
      setIsLoading(false);
    }
  }, [playerName, createRoom]);

  const handleJoinRoom = useCallback(async () => {
    if (!playerName.trim()) {
      setError("Please enter your name first");
      return;
    }

    if (!roomCode.trim()) {
      setError("Please enter a room code");
      return;
    }

    setError(null);
    setIsLoading(true);

    try {
      const userId = getUserId();
      const normalizedCode = roomCode.trim().toUpperCase();

      await joinRoom({
        userId,
        roomId: normalizedCode,
        playerName: playerName.trim(),
      });

      // Navigate to the room lobby
      window.location.href = `/room/${normalizedCode}?name=${encodeURIComponent(playerName.trim())}`;
    } catch (err) {
      if (err instanceof Error && err.message.includes("ROOM_404")) {
        setError("Room not found. Check the code and try again.");
      } else {
        const errorMessage =
          err instanceof Error ? err.message : "Failed to join room";
        setError(errorMessage);
      }
    } finally {
      setIsLoading(false);
    }
  }, [playerName, roomCode, joinRoom]);

  const canJoin = playerName.trim().length > 0 && roomCode.trim().length > 0;
  const canCreate = playerName.trim().length > 0;

  return (
    <main className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 p-4">
      <Card className="w-full max-w-md bg-slate-800/50 border-slate-700 backdrop-blur-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-3xl font-bold text-white">
            King&apos;s Cup
          </CardTitle>
          <CardDescription className="text-slate-300">
            The classic drinking game, now online
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Player Name Input */}
          <div className="space-y-2">
            <label
              htmlFor="playerName"
              className="text-sm font-medium text-slate-200"
            >
              Your Name
            </label>
            <Input
              id="playerName"
              type="text"
              placeholder="Enter your name"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              className="bg-slate-700/50 border-slate-600 text-white placeholder:text-slate-400 focus:border-purple-500"
              maxLength={20}
            />
          </div>

          {/* Join Room Section */}
          <div className="space-y-3">
            <div className="space-y-2">
              <label
                htmlFor="roomCode"
                className="text-sm font-medium text-slate-200"
              >
                Room Code
              </label>
              <Input
                id="roomCode"
                type="text"
                placeholder="Enter 6-character code"
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
                className="bg-slate-700/50 border-slate-600 text-white placeholder:text-slate-400 focus:border-purple-500 uppercase tracking-widest text-center font-mono text-lg"
                maxLength={6}
              />
            </div>
            <Button
              onClick={handleJoinRoom}
              disabled={!canJoin || isLoading}
              className="w-full bg-purple-600 hover:bg-purple-700 text-white disabled:opacity-50"
            >
              {isLoading ? "Joining..." : "Join Room"}
            </Button>
          </div>

          {/* Divider */}
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-slate-600" />
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="bg-slate-800 px-4 text-slate-400">or</span>
            </div>
          </div>

          {/* Create Room Section */}
          <Button
            onClick={handleCreateRoom}
            disabled={!canCreate || isLoading}
            variant="outline"
            className="w-full border-slate-600 text-slate-200 hover:bg-slate-700 hover:text-white disabled:opacity-50"
          >
            {isLoading ? "Creating..." : "Create New Room"}
          </Button>

          {/* Error Message */}
          {error && (
            <div className="p-3 rounded-md bg-red-900/50 border border-red-700 text-red-200 text-sm text-center">
              {error}
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
