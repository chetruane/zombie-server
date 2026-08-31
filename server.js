const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { getDistance } = require('geolib');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const activePlayers = {};

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // Roll 50/50 role on connection
  activePlayers[socket.id] = {
    id: socket.id,
    role: Math.random() < 0.5 ? 'ZOMBIE' : 'SURVIVOR',
    latitude: null,
    longitude: null,
  };

  socket.emit('init_player', activePlayers[socket.id]);

  socket.on('update_location', (coords) => {
    if (!activePlayers[socket.id]) return;
    activePlayers[socket.id].latitude = coords.latitude;
    activePlayers[socket.id].longitude = coords.longitude;
  });

  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    delete activePlayers[socket.id];
    io.emit('game_state', Object.values(activePlayers));
  });
});

// Continuous loop checking 10m tag collisions every 1 second
setInterval(() => {
  const playersList = Object.values(activePlayers).filter((p) => p.latitude && p.longitude);
  const zombies = playersList.filter((p) => p.role === 'ZOMBIE');
  const survivors = playersList.filter((p) => p.role === 'SURVIVOR');

  zombies.forEach((zombie) => {
    survivors.forEach((survivor) => {
      // Verify target is still a survivor in activePlayers before calculating distance
      if (activePlayers[survivor.id]?.role !== 'SURVIVOR') return;

      const distance = getDistance(
        { latitude: zombie.latitude, longitude: zombie.longitude },
        { latitude: survivor.latitude, longitude: survivor.longitude }
      );

      // Trigger infection if within 10 meters
      if (distance <= 9) {
        activePlayers[survivor.id].role = 'ZOMBIE';
        io.emit('player_infected', { infectedId: survivor.id });
      }
    });
  });

  io.emit('game_state', Object.values(activePlayers));
}, 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server active on port ${PORT}`));
