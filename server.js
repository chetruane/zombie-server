const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { getDistance, computeDestinationPoint } = require('geolib');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const activePlayers = {};
const ipMemory = {}; 
let powerups = [];
let powerupIdCounter = 0;

io.on('connection', (socket) => {
  const ip = socket.handshake.address;
  const now = Date.now();
  const ghostSocketId = Object.keys(activePlayers).find(id => activePlayers[id].ip === ip);

  let pData = {
    role: Math.random() < 0.5 ? 'ZOMBIE' : 'SURVIVOR',
    canInfectAt: now + 30000,
    score: 0,
    survivorStartTime: now,
    vaccineUntil: 0,
    radarUntil: 0
  };

  if (ghostSocketId) {
    pData = { ...activePlayers[ghostSocketId] };
    delete activePlayers[ghostSocketId];
    if (ipMemory[ip]) { clearTimeout(ipMemory[ip].timeout); delete ipMemory[ip]; }
  } else if (ipMemory[ip]) {
    pData = { ...ipMemory[ip] };
    clearTimeout(ipMemory[ip].timeout);
    delete ipMemory[ip];
  } else {
    pData.survivorStartTime = now;
  }

  activePlayers[socket.id] = { id: socket.id, ip, latitude: null, longitude: null, ...pData };
  socket.emit('init_player', activePlayers[socket.id]);

  socket.on('update_location', (coords) => {
    if (!activePlayers[socket.id]) return;
    activePlayers[socket.id].latitude = coords.latitude;
    activePlayers[socket.id].longitude = coords.longitude;
  });

  socket.on('disconnect', (reason) => {
    if (reason !== 'client namespace disconnect' && activePlayers[socket.id]) {
      ipMemory[ip] = {
        ...activePlayers[socket.id],
        timeout: setTimeout(() => delete ipMemory[ip], 60000),
      };
    }
    delete activePlayers[socket.id];
  });
});

// Spawn Powerups every 15 minutes
setInterval(() => {
  Object.values(activePlayers).forEach(p => {
    if (!p.latitude) return;
    const distance = Math.floor(Math.random() * 2970) + 30; 
    const bearing = Math.floor(Math.random() * 360);
    const loc = computeDestinationPoint({ latitude: p.latitude, longitude: p.longitude }, distance, bearing);
    
    powerups.push({
      id: powerupIdCounter++,
      type: Math.random() < 0.5 ? 'VACCINE' : 'RADAR',
      latitude: loc.latitude,
      longitude: loc.longitude
    });
  });
}, 900000);

// Main Game Loop (1 second)
setInterval(() => {
  const playersList = Object.values(activePlayers).filter((p) => p.latitude && p.longitude);
  const zombies = playersList.filter((p) => p.role === 'ZOMBIE');
  const survivors = playersList.filter((p) => p.role === 'SURVIVOR');
  const now = Date.now();

  playersList.forEach(player => {
    // Score update
    if (player.role === 'SURVIVOR') {
      player.score = Math.floor((now - player.survivorStartTime) / 60000);
    }

    // Powerup Collisions
    powerups.forEach((pu, index) => {
      if (getDistance({ latitude: player.latitude, longitude: player.longitude }, pu) <= 20) {
        if (pu.type === 'VACCINE') {
          if (player.role === 'ZOMBIE') {
            player.role = 'SURVIVOR';
            player.survivorStartTime = now;
          }
          player.vaccineUntil = now + 600000;
        } else if (pu.type === 'RADAR') {
          player.radarUntil = now + 600000;
        }
        io.to(player.id).emit('play_sound', 'powerup');
        powerups.splice(index, 1);
      }
    });
  });

  // Infection Logic
  zombies.forEach((zombie) => {
    if (now < zombie.canInfectAt) return;
    survivors.forEach((survivor) => {
      if (now < survivor.vaccineUntil || activePlayers[survivor.id]?.role !== 'SURVIVOR') return;

      if (getDistance({ latitude: zombie.latitude, longitude: zombie.longitude }, survivor) <= 10) {
        activePlayers[survivor.id].role = 'ZOMBIE';
        activePlayers[zombie.id].score += 1;
        
        io.to(survivor.id).emit('player_infected', { infectedId: survivor.id });
        io.to(zombie.id).emit('play_sound', 'yummy');
      }
    });
  });

  io.emit('game_state', { players: Object.values(activePlayers), powerups });
}, 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server active on port ${PORT}`));
