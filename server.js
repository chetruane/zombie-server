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
  if (r < 0.20) return 'VACCINE';     // 20%
  if (r < 0.45) return 'MITOSIS';     // 25%
  if (r < 0.70) return 'RADAR';       // 25%
  return 'RIFLE';                     // 30%
}

io.on('connection', (socket) => {
  const rawIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
  const ip = typeof rawIp === 'string' ? rawIp.split(',')[0].trim() : rawIp;

  let pData = {
    role: 'PENDING',
    canInfectAt: 0,
    score: 0,
    survivorStartTime: 0,
    vaccineUntil: 0,
    radarUntil: 0,
    rifleAmmo: 0,
    hitCount: 0,
    lastHitTime: 0,
    injuredUntil: 0
  };

  const ghostSocketId = Object.keys(activePlayers).find(id => activePlayers[id].ip === ip);

  if (ghostSocketId) {
    pData = { ...activePlayers[ghostSocketId] };
    delete activePlayers[ghostSocketId];
    if (ipMemory[ip]) { clearTimeout(ipMemory[ip].timeout); delete ipMemory[ip]; }
  } else if (ipMemory[ip]) {
    pData = { ...ipMemory[ip] };
    clearTimeout(ipMemory[ip].timeout);
    delete ipMemory[ip];
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
      if (player.role === 'PENDING') {
        const activeSurvivors = Object.values(activePlayers).filter(p => p.id !== socket.id && p.role === 'SURVIVOR' && p.latitude);
        const hasNearbySurvivor = activeSurvivors.some(sur => getDistance(coords, sur) <= 10000);

        if (!hasNearbySurvivor) {
          player.role = 'SURVIVOR';
          player.survivorStartTime = Date.now();

          const hasNearbyZombie = Object.values(activePlayers).some(p => p.id !== socket.id && p.role === 'ZOMBIE' && p.latitude && getDistance(coords, p) <= 6000) ||
                               npcZombies.some(nz => getDistance(coords, nz) <= 6000);

          if (!hasNearbyZombie) {
            for (let i = 0; i < 38; i++) {
              const distance = Math.floor(Math.random() * 3121) + 80; 
              const bearing = Math.floor(Math.random() * 360);
              const loc = computeDestinationPoint(coords, distance, bearing);
              npcZombies.push({
                id: npcZombieIdCounter++,
                latitude: loc.latitude,
                longitude: loc.longitude,
                canInfectAt: Date.now() + 2000,
                hitCount: 0,
                lastHitTime: 0
              });
            }
          }
        } else {
          player.role = Math.random() < 0.8 ? 'ZOMBIE' : 'SURVIVOR';
          if (player.role === 'ZOMBIE') {
            player.canInfectAt = Date.now() + 30000;
          } else {
            player.survivorStartTime = Date.now();
          }
        }
        
        socket.emit('init_player', player);
      }

      const nearbyPowerup = powerups.some(pu => getDistance(coords, pu) <= 2000);

      if (!nearbyPowerup) {
        for (let i = 0; i < 9; i++) {
          const distance = Math.floor(Math.random() * 1950) + 50;
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

  socket.on('fire_rifle', (targetCoords) => {
    const player = activePlayers[socket.id];
    if (!player || !player.latitude || player.rifleAmmo <= 0 || player.injuredUntil > Date.now()) return;

    player.rifleAmmo -= 1;
    const playerLoc = { latitude: player.latitude, longitude: player.longitude };
    
    let bearing = 0;
    try {
      bearing = getRhumbLineBearing(playerLoc, targetCoords);
    } catch (e) {
      bearing = 0;
    }

    const endPos = computeDestinationPoint(playerLoc, 420, bearing);

    Object.values(activePlayers).forEach(p => {
      if (p.latitude && getDistance(playerLoc, p) <= 1000) {
        io.to(p.id).emit('play_sound', 'rifle');
      }
    });

    io.emit('rifle_shot', {
      id: Date.now() + Math.random(),
      start: playerLoc,
      end: endPos
    });

    const checkHit = (targetLoc) => {
      const dist = getDistance(playerLoc, targetLoc);
      if (dist > 420) return false;
      let targetBearing = getRhumbLineBearing(playerLoc, targetLoc);
      let angleDiff = Math.abs(bearing - targetBearing);
      if (angleDiff > 180) angleDiff = 360 - angleDiff;
      const perpDist = dist * Math.sin((angleDiff * Math.PI) / 180);
      return perpDist <= 15;
    };

    let hitNpcIndex = -1;
    let minNpcDist = Infinity;
    npcZombies.forEach((npc, index) => {
      if (checkHit(npc)) {
        const d = getDistance(playerLoc, npc);
        if (d < minNpcDist) {
          minNpcDist = d;
          hitNpcIndex = index;
        }
      }
    });

    if (hitNpcIndex !== -1) {
      const npc = npcZombies[hitNpcIndex];
      const now = Date.now();

      if (typeof npc.hitCount === 'undefined') {
        npc.hitCount = 0;
        npc.lastHitTime = 0;
      }

      if (now - npc.lastHitTime > 30000) {
        npc.hitCount = 0;
      }

      npc.hitCount += 1;
      npc.lastHitTime = now;

      if (npc.hitCount >= 3) {
        npcZombies.splice(hitNpcIndex, 1);
        io.to(player.id).emit('play_sound', 'powerup');
      }
      return;
    }

    let hitPlayer = null;
    let minPlayerDist = Infinity;
    Object.values(activePlayers).forEach(p => {
      if (p.id !== player.id && p.latitude && checkHit(p)) {
        const d = getDistance(playerLoc, p);
        if (d < minPlayerDist) {
          minPlayerDist = d;
          hitPlayer = p;
        }
      }
    });

    if (hitPlayer) {
      const now = Date.now();
      if (now - hitPlayer.lastHitTime > 30000 && hitPlayer.injuredUntil <= now) {
        hitPlayer.hitCount = 0;
      }

      hitPlayer.hitCount += 1;
      hitPlayer.lastHitTime = now;

      if (hitPlayer.hitCount >= 3) {
        hitPlayer.injuredUntil = now + 60000;
        io.to(player.id).emit('play_sound', 'powerup');
      }
    }
  });

  socket.on('dev_swap_role', () => {
    const player = activePlayers[socket.id];
    if (!player) return;
    if (player.role === 'ZOMBIE') {
      player.role = 'SURVIVOR';
      player.survivorStartTime = Date.now();
      player.score = 0;
    } else {
      player.role = 'ZOMBIE';
      player.canInfectAt = Date.now();
      player.score = 0;
    }
  });

  socket.on('dev_activate_vaccine', () => {
    const player = activePlayers[socket.id];
    if (!player) return;
    if (player.role === 'ZOMBIE') {
      player.role = 'SURVIVOR';
      player.survivorStartTime = Date.now();
      player.score = 0;
    }
    player.vaccineUntil = Date.now() + 600000;
  });

  socket.on('dev_activate_radar', () => {
    const player = activePlayers[socket.id];
    if (!player) return;
    player.radarUntil = Date.now() + 600000;
  });

  socket.on('dev_activate_mitosis', () => {
    const player = activePlayers[socket.id];
    if (!player || !player.latitude) return;
    npcZombies.push({
      id: npcZombieIdCounter++,
      latitude: player.latitude,
      longitude: player.longitude,
      canInfectAt: Date.now() + 2000,
      hitCount: 0,
      lastHitTime: 0
    });
  });

  socket.on('dev_spawn_zombie', () => {
    const player = activePlayers[socket.id];
    if (!player || !player.latitude) return;
    const distance = 50;
    const bearing = Math.floor(Math.random() * 360);
    const loc = computeDestinationPoint({ latitude: player.latitude, longitude: player.longitude }, distance, bearing);
    npcZombies.push({
      id: npcZombieIdCounter++,
      latitude: loc.latitude,
      longitude: loc.longitude,
      canInfectAt: Date.now() + 2000,
      hitCount: 0,
      lastHitTime: 0
    });
  });

  socket.on('dev_give_rifle', () => {
    const player = activePlayers[socket.id];
    if (!player) return;
    player.rifleAmmo = 12;
  });

  socket.on('dev_clear_zombies', () => {
    const player = activePlayers[socket.id];
    if (!player || !player.latitude) return;
    const playerLoc = { latitude: player.latitude, longitude: player.longitude };
    npcZombies = npcZombies.filter(npc => getDistance(playerLoc, npc) > 1000);
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
}, 240000);

setInterval(() => {
  const playersList = Object.values(activePlayers).filter((p) => p.latitude && p.longitude && p.role !== 'PENDING');
  const zombies = playersList.filter((p) => p.role === 'ZOMBIE');
  const survivors = playersList.filter((p) => p.role === 'SURVIVOR');
  const now = Date.now();

  playersList.forEach(player => {
    if (player.role === 'SURVIVOR') {
      player.score = Math.floor((now - player.survivorStartTime) / 60000);
    }

    if (player.hitCount > 0 && player.hitCount < 3 && now - player.lastHitTime > 30000) {
      player.hitCount = 0;
    }

    powerups.forEach((pu, index) => {
      if (getDistance({ latitude: player.latitude, longitude: player.longitude }, pu) <= 40) {
        if (pu.type === 'VACCINE') {
          if (player.role === 'ZOMBIE') {
            player.role = 'SURVIVOR';
            player.survivorStartTime = now;
            player.score = 0;
          }
          player.vaccineUntil = now + 600000;
          io.to(player.id).emit('play_sound', 'powerup');
          powerups.splice(index, 1);
        } else if (pu.type === 'RADAR') {
          player.radarUntil = now + 600000;
          io.to(player.id).emit('play_sound', 'powerup');
          powerups.splice(index, 1);
        } else if (pu.type === 'MITOSIS') {
          npcZombies.push({
            id: npcZombieIdCounter++,
            latitude: player.latitude,
            longitude: player.longitude,
            canInfectAt: now + 2000,
            hitCount: 0,
            lastHitTime: 0
          });
          io.to(player.id).emit('play_sound', 'powerup');
          powerups.splice(index, 1);
        } else if (pu.type === 'RIFLE') {
          if (player.role === 'SURVIVOR') {
            player.rifleAmmo = 12;
            io.to(player.id).emit('play_sound', 'powerup');
            powerups.splice(index, 1);
          }
        }
      }
    });
  });

  zombies.forEach((zombie) => {
    if (now < zombie.canInfectAt || zombie.injuredUntil > now) return;
    survivors.forEach((survivor) => {
      if (now < survivor.vaccineUntil || activePlayers[survivor.id]?.role !== 'SURVIVOR') return;

      if (getDistance({ latitude: zombie.latitude, longitude: zombie.longitude }, survivor) <= 20) {
        if (survivor.rifleAmmo > 0) {
          powerups.push({
            id: powerupIdCounter++,
            type: 'RIFLE',
            latitude: survivor.latitude,
            longitude: survivor.longitude
          });
          survivor.rifleAmmo = 0;
        }

        activePlayers[survivor.id].role = 'ZOMBIE';
        activePlayers[survivor.id].score = 0;
        activePlayers[zombie.id].score += 1;
        
        io.to(survivor.id).emit('player_infected', { infectedId: survivor.id });
        io.to(zombie.id).emit('play_sound', 'yummy');
      }
    });
  });

  npcZombies.forEach((npc) => {
    if (npc.hitCount > 0 && npc.hitCount < 3 && now - npc.lastHitTime > 30000) {
      npc.hitCount = 0;
    }

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

    if (now >= npc.canInfectAt && minDistance <= 20) {
      if (now >= nearestSurvivor.vaccineUntil && activePlayers[nearestSurvivor.id]?.role === 'SURVIVOR') {
        if (nearestSurvivor.rifleAmmo > 0) {
          powerups.push({
            id: powerupIdCounter++,
            type: 'RIFLE',
            latitude: nearestSurvivor.latitude,
            longitude: nearestSurvivor.longitude
          });
          nearestSurvivor.rifleAmmo = 0;
        }

        activePlayers[nearestSurvivor.id].role = 'ZOMBIE';
        activePlayers[nearestSurvivor.id].score = 0;
        io.to(nearestSurvivor.id).emit('player_infected', { infectedId: nearestSurvivor.id });
      }
    }

    if (minDistance <= 750) {
      try {
        const bearing = getRhumbLineBearing(npc, nearestSurvivor);
        const nextPos = computeDestinationPoint(npc, 2.5, bearing);
        npc.latitude = nextPos.latitude;
        npc.longitude = nextPos.longitude;
      } catch (e) {}
    }
  });

  const filteredPlayers = Object.values(activePlayers).map(p => {
    if (p.injuredUntil > now) {
      return { ...p, latitude: null, longitude: null };
    }
    return p;
  });

  io.emit('game_state', { players: filteredPlayers, powerups, npcZombies });
}, 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server active on port ${PORT}`));