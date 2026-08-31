const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { getDistance } = require('geolib');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const activePlayers = {};
const ipMemory = {}; // Caches roles for network drops

io.on('connection', (socket) => {
  const ip = socket.handshake.address;
  const now = Date.now();

  // 1. Check if the server still thinks your old connection is active (Ghost Socket)
  const ghostSocketId = Object.keys(activePlayers).find(id => activePlayers[id].ip === ip);

  let assignedRole;
  let infectCooldown = now + 30000;

  if (ghostSocketId) {
    // FAST NETWORK DROP: You reconnected before the server timed out your old socket.
    // Transfer your exact state over to the new connection.
    assignedRole = activePlayers[ghostSocketId].role;
    infectCooldown = activePlayers[ghostSocketId].canInfectAt;
    delete activePlayers[ghostSocketId]; // Clean up the ghost
    
    if (ipMemory[ip]) {
      clearTimeout(ipMemory[ip].timeout);
      delete ipMemory[ip];
    }
  } else if (ipMemory[ip]) {
    // SLOW NETWORK DROP: The server timed you out and saved your state to memory.
    assignedRole = ipMemory[ip].role;
    infectCooldown = ipMemory[ip].canInfectAt;
    clearTimeout(ipMemory[ip].timeout);
    delete ipMemory[ip];
  } else {
    // MANUAL REJOIN OR BRAND NEW PLAYER: 
    // Manual rejoins gracefully close the old socket, skipping the memory checks above.
    assignedRole = Math.random() < 0.5 ? 'ZOMBIE' : 'SURVIVOR';
  }

  console.log(`Player connected: ${socket.id} (IP: ${ip}) - Role: ${assignedRole}`);

  activePlayers[socket.id] = {
    id: socket.id,
    ip: ip,
    role: assignedRole,
    latitude: null,
    longitude: null,
    canInfectAt: infectCooldown,
  };

  socket.emit('init_player', activePlayers[socket.id]);

  socket.on('update_location', (coords) => {
    if (!activePlayers[socket.id]) return;
    activePlayers[socket.id].latitude = coords.latitude;
    activePlayers[socket.id].longitude = coords.longitude;
  });

  socket.on('disconnect', (reason) => {
    // ONLY save state to memory if it was an accidental network drop.
    // If the reason is 'client namespace disconnect' (the Rejoin button), skip saving.
    if (reason !== 'client namespace disconnect') {
      const player = activePlayers[socket.id];
      if (player) {
        ipMemory[ip] = {
          role: player.role,
          canInfectAt: player.canInfectAt,
          timeout: setTimeout(() => {
            delete ipMemory[ip];
          }, 60000), // 1 minute memory
        };
      }
    }
    delete activePlayers[socket.id];
    io.emit('game_state', Object.values(activePlayers));
  });
});

setInterval(() => {
  const playersList = Object.values(activePlayers).filter((p) => p.latitude && p.longitude);
  const zombies = playersList.filter((p) => p.role === 'ZOMBIE');
  const survivors = playersList.filter((p) => p.role === 'SURVIVOR');

  const now = Date.now();

  zombies.forEach((zombie) => {
    if (now < zombie.canInfectAt) return;

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
