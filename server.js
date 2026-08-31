const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { getDistance } = require('geolib');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const activePlayers = {};
const ipMemory = {}; // Caches roles by IP address for 60 seconds

io.on('connection', (socket) => {
  const ip = socket.handshake.address;
  let assignedRole = Math.random() < 0.5 ? 'ZOMBIE' : 'SURVIVOR';

  // If this IP accidentally disconnected within the last minute, restore their role
  if (ipMemory[ip]) {
    assignedRole = ipMemory[ip].role;
    clearTimeout(ipMemory[ip].timeout);
    delete ipMemory[ip];
  }

  console.log(`Player connected: ${socket.id} (IP: ${ip})`);

  // Assign role to the NEW socket ID so the unmodified app can find itself
  activePlayers[socket.id] = {
    id: socket.id,
    role: assignedRole,
    latitude: null,
    longitude: null,
  };

  socket.emit('init_player', activePlayers[socket.id]);

  socket.on('update_location', (coords) => {
    if (!activePlayers[socket.id]) return;
    activePlayers[socket.id].latitude = coords.latitude;
    activePlayers[socket.id].longitude = coords.longitude;
  });

  socket.on('disconnect', (reason) => {
    console.log(`Player disconnected: ${socket.id} - Reason: ${reason}`);
    
    // If it was a network drop, save their state. 
    // If reason is 'client namespace disconnect' (the Rejoin button), skip saving so they re-roll.
    if (reason !== 'client namespace disconnect') {
      const savedRole = activePlayers[socket.id]?.role;
      if (savedRole) {
        ipMemory[ip] = {
          role: savedRole,
          timeout: setTimeout(() => {
            delete ipMemory[ip];
          }, 60000) // 1 minute
        };
      }
    }

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
      if (activePlayers[survivor.id]?.role !== 'SURVIVOR') return;

      const distance = getDistance(
        { latitude: zombie.latitude, longitude: zombie.longitude },
        { latitude: survivor.latitude, longitude: survivor.longitude }
      );

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
