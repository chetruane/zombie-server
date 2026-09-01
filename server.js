const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { getDistance, computeDestinationPoint, getRhumbLineBearing } = require('geolib');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const activePlayers = {};
const ipMemory = {}; 
let powerups = [];
let powerupIdCounter = 0;
let npcZombies = [];
let npcZombieIdCounter = 0;

function getRandomPowerupType() {
  const r = Math.random();
  if (r < 0.4) return 'RADAR';       // 40%
  if (r < 0.7) return 'VACCINE';     // 30%
  return 'MITOSIS';                  // 30%
}

io.on('connection', (socket) => {
  // Extract real client IP behind Render's reverse proxy
  const rawIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
  const ip = typeof rawIp === 'string' ? rawIp.split(',')[0].trim() : rawIp;
  
  const now = Date.now();
  const ghostSocketId = Object.keys(activePlayers).find(id => activePlayers[id].ip === ip);

  let pData = {
    role: Math.random() < 0.7 ? 'ZOMBIE' : 'SURVIVOR',
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

  activePlayers[socket.id] = { ...pData, ip, latitude: null, longitude: null, id: socket.id };
  socket.emit('init_player', activePlayers[socket.id]);

  socket.on('update_location', (coords) => {
    const player = activePlayers[socket.id];
    if (!player) return;

    const isFirstSpawn = !player.latitude;

    player.latitude = coords.latitude;
    player.longitude = coords.longitude;

    if (isFirstSpawn) {
      const nearbyPowerup = powerups.some(pu => getDistance(coords, pu) <= 2000);

      if (!nearbyPowerup) {
        for (let i = 0; i < 12; i++) {
          const distance = Math.floor(Math.random() * 2450) + 50;
          const bearing = Math.floor(Math.random() * 360);
          const loc = computeDestinationPoint(coords, distance, bearing);

          powerups.push({
            id: powerupIdCounter++,
            type: getRandomPowerupType(),
            latitude: loc.latitude,
            longitude: loc.longitude
          });
        }
      }
    }
  });

  // Dev feature: swap role instantly
  socket.on('dev_swap_role', () => {
    const player = activePlayers[socket.id];
    if (!player) return;
    
    if (player.role === 'ZOMBIE') {
      player.role = 'SURVIVOR';
      player.survivorStartTime = Date.now();
    } else {
      player.role = 'ZOMBIE';
      player.canInfectAt = Date.now();
    }
  });

  socket.on('disconnect', (reason) => {
    if (reason !== 'client namespace disconnect' && activePlayers[socket.id]) {
      ipMemory[ip] = {
        ...activePlayers[socket.id],
        timeout: setTimeout(() => delete ipMemory[ip], 180000),
      };
    }
    delete activePlayers[socket.id];
  });
});

// Spawn Powerups every 5 minutes
setInterval(() => {
  Object.values(activePlayers).forEach(p => {
    if (!p.latitude) return;
    const distance = Math.floor(Math.random() * 2970) + 30; 
    const bearing = Math.floor(Math.random() * 360);
    const loc = computeDestinationPoint({ latitude: p.latitude, longitude: p.longitude }, distance, bearing);
    
    powerups.push({
      id: powerupIdCounter++,
      type: getRandomPowerupType(),
      latitude: loc.latitude,
      longitude: loc.longitude
    });
  });
}, 300000);

// Main Game Loop (1 second)
setInterval(() => {
  const playersList = Object.values(activePlayers).filter((p) => p.latitude && p.longitude);
  const zombies = playersList.filter((p) => p.role === 'ZOMBIE');
  const survivors = playersList.filter((p) => p.role === 'SURVIVOR');
  const now = Date.now();

  playersList.forEach(player => {
    if (player.role === 'SURVIVOR') {
      player.score = Math.floor((now - player.survivorStartTime) / 60000);
    }

    powerups.forEach((pu, index) => {
      if (getDistance({ latitude: player.latitude, longitude: player.longitude }, pu) <= 40) {
        if (pu.type === 'VACCINE') {
          if (player.role === 'ZOMBIE') {
            player.role = 'SURVIVOR';
            player.survivorStartTime = now;
          }
          player.vaccineUntil = now + 600000;
        } else if (pu.type === 'RADAR') {
          player.radarUntil = now + 600000;
        } else if (pu.type === 'MITOSIS') {
          npcZombies.push({
            id: npcZombieIdCounter++,
            latitude: player.latitude,
            longitude: player.longitude
          });
        }
        io.to(player.id).emit('play_sound', 'powerup');
        powerups.splice(index, 1);
      }
    });
  });

  zombies.forEach((zombie) => {
    if (now < zombie.canInfectAt) return;
    survivors.forEach((survivor) => {
      if (now < survivor.vaccineUntil || activePlayers[survivor.id]?.role !== 'SURVIVOR') return;

      if (getDistance({ latitude: zombie.latitude, longitude: zombie.longitude }, survivor) <= 20) {
        activePlayers[survivor.id].role = 'ZOMBIE';
        activePlayers[zombie.id].score += 1;
        
        io.to(survivor.id).emit('player_infected', { infectedId: survivor.id });
        io.to(zombie.id).emit('play_sound', 'yummy');
      }
    });
  });

  // Update NPC Zombies movement and infection logic (3m/s towards nearest living survivor)
  npcZombies.forEach((npc, npcIndex) => {
    if (survivors.length === 0) return;

    let nearestSurvivor = survivors[0];
    let minDistance = getDistance(npc, nearestSurvivor);

    for (let i = 1; i < survivors.length; i++) {
      const dist = getDistance(npc, survivors[i]);
      if (dist < minDistance) {
        minDistance = dist;
        nearestSurvivor = survivors[i];
      }
    }

    if (minDistance <= 20) {
      if (now >= nearestSurvivor.vaccineUntil && activePlayers[nearestSurvivor.id]?.role === 'SURVIVOR') {
        activePlayers[nearestSurvivor.id].role = 'ZOMBIE';
        io.to(nearestSurvivor.id).emit('player_infected', { infectedId: nearestSurvivor.id });
        npcZombies.splice(npcIndex, 1);
        return;
      }
    }

    try {
      const bearing = getRhumbLineBearing(npc, nearestSurvivor);
      const nextPos = computeDestinationPoint(npc, 3, bearing);
      npc.latitude = nextPos.latitude;
      npc.longitude = nextPos.longitude;
    } catch (e) {
      // Ignore if points are identical
    }
  });

  io.emit('game_state', { players: Object.values(activePlayers), powerups, npcZombies });
}, 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server active on port ${PORT}`));