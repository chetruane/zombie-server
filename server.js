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

  // Check if an active player entry already exists for this IP
  const existingSocketId = Object.keys(activePlayers).find(
    (id) => activePlayers[id].ip === ip
  );

  let assignedRole;
  let infectCooldown = now + 30000; // 30-second cooldown for new/rerolled roles

  // DISTINGUISH REROLL VS NETWORK DROP:
  // If the IP was connected moments ago (< 2s disconnect), treat it as a deliberate Rejoin/Reroll.
  // If it disconnected > 2s ago, treat it as a network drop recovery.
  if (existingSocketId || (ipMemory[ip] && now - ipMemory[ip].disconnectTime <= 2000)) {
    // MANUAL REJOIN / REROLL: Force a fresh 50/50 role roll
    assignedRole = Math.random() < 0.5 ? 'ZOMBIE' : 'SURVIVOR';

    if (existingSocketId) delete activePlayers[existingSocketId];
    if (ipMemory[ip]) {
      clearTimeout(ipMemory[ip].timeout);
      delete ipMemory[ip];
    }
  } else if (ipMemory[ip] && now - ipMemory[ip].disconnectTime > 2000) {
    // NETWORK DROP RECOVERY: Restore saved role and original cooldown
    assignedRole = ipMemory[ip].role;
    infectCooldown = ipMemory[ip].canInfectAt;
    clearTimeout(ipMemory[ip].timeout);
    delete ipMemory[ip];
  } else {
    // BRAND NEW PLAYER
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

  socket.on('disconnect', () => {
    const player = activePlayers[socket.id];
    if (player) {
      // Save state with timestamp in case it's an accidental signal loss
      ipMemory[ip] = {
        role: player.role,
        canInfectAt: player.canInfectAt,
        disconnectTime: Date.now(),
        timeout: setTimeout(() => {
          delete ipMemory[ip];
        }, 60000), // 1 minute memory
      };
      delete activePlayers[socket.id];
    }
    io.emit('game_state', Object.values(activePlayers));
  });
});

// Continuous loop checking 10m tag collisions every 1 second
setInterval(() => {
  const playersList = Object.values(activePlayers).filter((p) => p.latitude && p.longitude);
  const zombies = playersList.filter((p) => p.role === 'ZOMBIE');
  const survivors = playersList.filter((p) => p.role === 'SURVIVOR');

  const now = Date.now();

  zombies.forEach((zombie) => {
    // Prevent newly joined/rerolled zombies from infecting anyone for 30 seconds
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
