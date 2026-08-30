// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { getDistance } = require('geolib');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// In-memory store for active session players
const activePlayers = {};

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // Roll 50/50 role immediately on drop-in
  const initialRole = Math.random() < 0.5 ? 'ZOMBIE' : 'SURVIVOR';
  
  activePlayers[socket.id] = {
    id: socket.id,
    role: initialRole,
    latitude: null,
    longitude: null,
    joinedAt: Date.now(),
  };

  // Send player their assigned role
  socket.emit('init_player', activePlayers[socket.id]);

  // Receive GPS updates from mobile clients
  socket.on('update_location', (coords) => {
    if (!activePlayers[socket.id]) return;
    activePlayers[socket.id].latitude = coords.latitude;
    activePlayers[socket.id].longitude = coords.longitude;
  });

  // Handle immediate cleanup on exit/rejoin
  socket.on('disconnect', () => {
    console.log(`Player left: ${socket.id}`);
    delete activePlayers[socket.id];
    io.emit('game_state', Object.values(activePlayers));
  });
});

// Continuous game tick (Runs 1x per second)
setInterval(() => {
  const playersList = Object.values(activePlayers).filter((p) => p.latitude && p.longitude);
  const zombies = playersList.filter((p) => p.role === 'ZOMBIE');
  const survivors = playersList.filter((p) => p.role === 'SURVIVOR');

  // Check 10-meter infection radii
  zombies.forEach((zombie) => {
    survivors.forEach((survivor) => {
      const distance = getDistance(
        { latitude: zombie.latitude, longitude: zombie.longitude },
        { latitude: survivor.latitude, longitude: survivor.longitude }
      );

      if (distance <= 10) {
        // Tag survivor -> turns zombie
        activePlayers[survivor.id].role = 'ZOMBIE';
        io.emit('player_infected', { infectedId: survivor.id, infectedBy: zombie.id });
      }
    });
  });

  // Broadcast current global map positions to everyone
  io.emit('game_state', Object.values(activePlayers));
}, 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Persistent Global Tag Server running on port ${PORT}`));