import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, Alert, ActivityIndicator, ScrollView } from 'react-native';
import MapView, { Marker, Circle, PROVIDER_DEFAULT } from 'react-native-maps';
import * as Location from 'expo-location';
import { Audio } from 'expo-av';
import { getDistance } from 'geolib';
import { io } from 'socket.io-client';

const SERVER_URL = 'https://zombie-server-53i4.onrender.com/';

export default function App() {
  const [fatalError, setFatalError] = useState(null);
  const [myPlayer, setMyPlayer] = useState(null);
  const [allPlayers, setAllPlayers] = useState([]);
  const [powerups, setPowerups] = useState([]);
  const [heatmapData, setHeatmapData] = useState([]);
  const [userLocation, setUserLocation] = useState(null);
  const [statusMessage, setStatusMessage] = useState('Initializing...');
  const [canReroll, setCanReroll] = useState(false);
  
  const socketRef = useRef(null);
  const soundsRef = useRef({});
  const spottedRef = useRef(false);
  const rerollTimerRef = useRef(null);

  // Global runtime crash interceptor
  useEffect(() => {
    const originalHandler = ErrorUtils.getGlobalHandler();
    ErrorUtils.setGlobalHandler((error) => {
      setFatalError(`Message: ${error?.message || error}\n\nStack:\n${error?.stack || 'No stack trace'}`);
    });
    return () => { if (originalHandler) ErrorUtils.setGlobalHandler(originalHandler); };
  }, []);

  // Audio Pre-loading
  useEffect(() => {
    async function loadAudio() {
      try {
        const { sound: spotted } = await Audio.Sound.createAsync(require('./assets/spotted.ogg'));
        const { sound: infected } = await Audio.Sound.createAsync(require('./assets/infected.ogg'));
        const { sound: yummy } = await Audio.Sound.createAsync(require('./assets/yummy.ogg'));
        const { sound: powerup } = await Audio.Sound.createAsync(require('./assets/powerup.ogg'));
        soundsRef.current = { spotted, infected, yummy, powerup };
      } catch (err) {
        console.log("Audio load error:", err);
      }
    }
    loadAudio();
    return () => Object.values(soundsRef.current).forEach(s => s?.unloadAsync());
  }, []);

  const connectSocket = () => {
    if (socketRef.current) socketRef.current.disconnect();
    setCanReroll(false);
    setStatusMessage('Connecting...');
    
    socketRef.current = io(SERVER_URL, { transports: ['websocket'], reconnection: true });

    socketRef.current.on('init_player', setMyPlayer);

    socketRef.current.on('game_state', (data) => {
      setAllPlayers(data.players || []);
      setPowerups(data.powerups || []);
      if (socketRef.current) {
        const self = data.players.find((p) => p.id === socketRef.current.id);
        if (self) setMyPlayer(self);
      }
    });

    socketRef.current.on('player_infected', () => {
      soundsRef.current.infected?.replayAsync();
      Alert.alert('INFECTED!', 'A zombie got within 10 meters of you! You are now a Zombie.');
    });

    socketRef.current.on('play_sound', (type) => {
      soundsRef.current[type]?.replayAsync();
    });
  };

  useEffect(() => {
    Location.requestForegroundPermissionsAsync().then(({ status }) => {
      if (status === 'granted') {
        connectSocket();
        Location.watchPositionAsync(
          { accuracy: Location.Accuracy.Balanced, timeInterval: 1000, distanceInterval: 1 },
          (pos) => {
            const coords = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
            setUserLocation(coords);
            if (socketRef.current?.connected) socketRef.current.emit('update_location', coords);
          }
        );
      } else {
        setStatusMessage('Location permission is required.');
      }
    });
  }, []);

  // Update Heatmap every 180s
  useEffect(() => {
    const interval = setInterval(() => {
      if (userLocation) {
        setHeatmapData(allPlayers.filter(p => getDistance(userLocation, p) > 5000));
      }
    }, 180000);
    return () => clearInterval(interval);
  }, [allPlayers, userLocation]);

  // Audio Proximity & 30s Reroll Logic
  useEffect(() => {
    if (!userLocation || !myPlayer) return;
    const oppositeRole = myPlayer.role === 'ZOMBIE' ? 'SURVIVOR' : 'ZOMBIE';
    const enemies = allPlayers.filter(p => p.role === oppositeRole && p.id !== myPlayer.id && p.latitude);
    
    // Zombie Proximity Alert for Survivors
    if (myPlayer.role === 'SURVIVOR') {
      const nearZombie = enemies.some(e => getDistance(userLocation, e) <= 20);
      if (nearZombie && !spottedRef.current) soundsRef.current.spotted?.replayAsync();
      spottedRef.current = nearZombie;
    }

    // Reroll Availability Timer (Requires no enemies within 5km for 30 continuous seconds)
    const enemyNearby = enemies.some(e => getDistance(userLocation, e) <= 5000);
    if (enemyNearby) {
      clearTimeout(rerollTimerRef.current);
      rerollTimerRef.current = null;
      setCanReroll(false);
    } else if (!rerollTimerRef.current && !canReroll) {
      rerollTimerRef.current = setTimeout(() => {
        setCanReroll(true);
      }, 30000);
    }
  }, [allPlayers, userLocation, myPlayer]);

  if (fatalError) {
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.errorTitle}>App Crash Diagnostic</Text>
        <ScrollView style={styles.errorScroll}><Text style={styles.errorText}>{fatalError}</Text></ScrollView>
        <TouchableOpacity style={styles.retryButton} onPress={() => setFatalError(null)}>
          <Text style={styles.retryText}>Dismiss</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!userLocation || !myPlayer) return <View style={styles.center}><ActivityIndicator size="large" color="#e74c3c" /><Text style={styles.loadingText}>{statusMessage}</Text></View>;

  const isZombie = myPlayer.role === 'ZOMBIE';
  const hasRadar = myPlayer.radarUntil > Date.now();
  const hasVaccine = myPlayer.vaccineUntil > Date.now();

  return (
    <View style={styles.container}>
      <MapView style={styles.map} provider={PROVIDER_DEFAULT} showsUserLocation={true} followsUserLocation={true} initialRegion={{latitude: userLocation.latitude, longitude: userLocation.longitude, latitudeDelta: 0.01, longitudeDelta: 0.01}}>
        
        {powerups.map((pu) => (
          <Marker key={`pu-${pu.id}`} coordinate={pu}>
            <Text style={{fontSize: 24}}>{pu.type === 'VACCINE' ? '💉' : '📡'}</Text>
          </Marker>
        ))}

        {allPlayers.map((p) => {
          if (!p.latitude || p.id === myPlayer.id) return null;
          const dist = getDistance(userLocation, p);
          if (dist > 5000 && !hasRadar) return null;

          return (
            <React.Fragment key={p.id}>
              <Marker coordinate={p} pinColor={p.role === 'ZOMBIE' ? 'red' : 'green'} />
              {p.role === 'ZOMBIE' && <Circle center={p} radius={10} fillColor="rgba(255,0,0,0.25)" strokeColor="red" />}
            </React.Fragment>
          );
        })}

        {!hasRadar && heatmapData.map((p) => (
          <Circle key={`heat-${p.id}`} center={p} radius={1500} fillColor={p.role === 'ZOMBIE' ? 'rgba(255,0,0,0.05)' : 'rgba(0,255,0,0.05)'} strokeWidth={0} />
        ))}
      </MapView>

      <View style={[styles.hud, isZombie ? styles.hudZombie : styles.hudSurvivor]}>
        <View style={styles.hudTopRow}>
          <Text style={styles.hudTitle}>{isZombie ? '🧟 ZOMBIE' : '🏃 SURVIVOR'}</Text>
          <Text style={styles.scoreText}>
            {isZombie ? `Brains: ${myPlayer.score}` : `Survived: ${myPlayer.score}m`}
          </Text>
        </View>
        
        {hasVaccine && <Text style={styles.vaccineText}>💉 IMMUNE: {Math.ceil((myPlayer.vaccineUntil - Date.now())/60000)}m left</Text>}
        
        {canReroll && (
          <TouchableOpacity style={styles.rejoinButton} onPress={connectSocket}>
            <Text style={styles.rejoinText}>REROLL (Safe Zone)</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#111' },
  loadingText: { color: '#fff', marginTop: 12 },
  errorContainer: { flex: 1, backgroundColor: '#1a0000', padding: 24, justifyContent: 'center' },
  errorTitle: { color: '#ff4444', fontSize: 20, fontWeight: 'bold', marginBottom: 12 },
  errorScroll: { backgroundColor: '#111', padding: 12, borderRadius: 8, maxHeight: 400 },
  errorText: { color: '#ff8888', fontFamily: 'monospace', fontSize: 12 },
  retryButton: { marginTop: 16, backgroundColor: '#c0392b', padding: 14, borderRadius: 8, alignItems: 'center' },
  retryText: { color: '#fff', fontWeight: 'bold' },
  hud: { position: 'absolute', top: 50, left: 16, right: 16, padding: 16, borderRadius: 14, elevation: 8 },
  hudTopRow: { flexDirection: 'row', justifyContent: 'space-between', width: '100%', alignItems: 'center' },
  hudZombie: { backgroundColor: 'rgba(144, 12, 63, 0.92)' },
  hudSurvivor: { backgroundColor: 'rgba(30, 132, 73, 0.92)' },
  hudTitle: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  scoreText: { color: '#ffd700', fontSize: 16, fontWeight: 'bold' },
  vaccineText: { color: '#00ffff', fontSize: 14, marginTop: 8, fontWeight: 'bold', textAlign: 'center' },
  rejoinButton: { marginTop: 12, backgroundColor: 'rgba(255,255,255,0.25)', padding: 10, borderRadius: 8, alignItems: 'center' },
  rejoinText: { color: '#fff', fontWeight: 'bold', fontSize: 12 },
});