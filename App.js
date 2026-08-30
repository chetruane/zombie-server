import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, Alert, ActivityIndicator, ScrollView } from 'react-native';
import MapView, { Marker, Circle, PROVIDER_DEFAULT } from 'react-native-maps';
import * as Location from 'expo-location';
import { io } from 'socket.io-client';

const SERVER_URL = 'https://zombie-server-53i4.onrender.com/';

export default function App() {
  const [fatalError, setFatalError] = useState(null);
  const [myPlayer, setMyPlayer] = useState(null);
  const [allPlayers, setAllPlayers] = useState([]);
  const [userLocation, setUserLocation] = useState(null);
  const [statusMessage, setStatusMessage] = useState('Initializing...');
  const socketRef = useRef(null);

  // Global runtime crash interceptor
  useEffect(() => {
    const originalHandler = ErrorUtils.getGlobalHandler();
    ErrorUtils.setGlobalHandler((error, isFatal) => {
      const errorDetails = `Message: ${error?.message || error}\n\nStack:\n${error?.stack || 'No stack trace available'}`;
      setFatalError(errorDetails);
    });

    return () => {
      if (originalHandler) ErrorUtils.setGlobalHandler(originalHandler);
    };
  }, []);

  const connectSocket = () => {
    if (socketRef.current) socketRef.current.disconnect();

    setStatusMessage('Connecting to game server...');
    
    socketRef.current = io(SERVER_URL, {
      transports: ['websocket'],
      reconnection: true,
      timeout: 10000,
    });

    socketRef.current.on('connect', () => {
      setStatusMessage('Connected! Acquiring GPS fix...');
    });

    socketRef.current.on('connect_error', (err) => {
      setStatusMessage(`Connection failed: ${err.message}`);
    });

    socketRef.current.on('init_player', (playerData) => {
      setMyPlayer(playerData);
    });

    socketRef.current.on('game_state', (playersList) => {
      setAllPlayers(playersList);
      if (socketRef.current) {
        const self = playersList.find((p) => p.id === socketRef.current.id);
        if (self) setMyPlayer(self);
      }
    });

    socketRef.current.on('player_infected', ({ infectedId }) => {
      if (socketRef.current && infectedId === socketRef.current.id) {
        Alert.alert('INFECTED!', 'A zombie got within 10 meters of you! You are now a Zombie.');
      }
    });
  };

  useEffect(() => {
    let locationSub = null;

    async function setupLocationAndSocket() {
      try {
        let { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          setStatusMessage('Location permission is required to play.');
          return;
        }

        connectSocket();

        let lastLoc = await Location.getLastKnownPositionAsync();
        if (lastLoc) {
          setUserLocation({
            latitude: lastLoc.coords.latitude,
            longitude: lastLoc.coords.longitude,
          });
        }

        locationSub = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.Balanced,
            timeInterval: 1000,
            distanceInterval: 1,
          },
          (position) => {
            const coords = {
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
            };
            setUserLocation(coords);
            if (socketRef.current && socketRef.current.connected) {
              socketRef.current.emit('update_location', coords);
            }
          }
        );
      } catch (err) {
        setStatusMessage(`GPS Error: ${err.message}`);
      }
    }

    setupLocationAndSocket();

    return () => {
      if (locationSub) locationSub.remove();
      if (socketRef.current) socketRef.current.disconnect();
    };
  }, []);

  // If a runtime crash happens anywhere, display it nicely on screen instead of closing
  if (fatalError) {
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.errorTitle}>🚨 App Crash Diagnostic Log</Text>
        <ScrollView style={styles.errorScroll}>
          <Text style={styles.errorText}>{fatalError}</Text>
        </ScrollView>
        <TouchableOpacity 
          style={styles.retryButton} 
          onPress={() => setFatalError(null)}
        >
          <Text style={styles.retryText}>Dismiss / Try Again</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!userLocation || !myPlayer) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#e74c3c" />
        <Text style={styles.loadingText}>{statusMessage}</Text>
      </View>
    );
  }

  const isZombie = myPlayer.role === 'ZOMBIE';

  return (
    <View style={styles.container}>
      <MapView
        style={styles.map}
        provider={PROVIDER_DEFAULT}
        initialRegion={{
          latitude: userLocation.latitude,
          longitude: userLocation.longitude,
          latitudeDelta: 0.002,
          longitudeDelta: 0.002,
        }}
        showsUserLocation={true}
        followsUserLocation={true}
      >
        {allPlayers.map((p) => {
          if (!p.latitude || !p.longitude) return null;
          const isSelf = p.id === myPlayer.id;
          const playerIsZombie = p.role === 'ZOMBIE';

          return (
            <React.Fragment key={p.id}>
              <Marker
                coordinate={{ latitude: p.latitude, longitude: p.longitude }}
                title={isSelf ? `YOU (${p.role})` : p.role}
                pinColor={playerIsZombie ? 'red' : 'green'}
              />
              {playerIsZombie && (
                <Circle
                  center={{ latitude: p.latitude, longitude: p.longitude }}
                  radius={10}
                  fillColor="rgba(255, 0, 0, 0.25)"
                  strokeColor="rgba(255, 0, 0, 0.7)"
                  strokeWidth={2}
                />
              )}
            </React.Fragment>
          );
        })}
      </MapView>

      <View style={[styles.hud, isZombie ? styles.hudZombie : styles.hudSurvivor]}>
        <Text style={styles.hudTitle}>
          {isZombie ? '🧟 YOU ARE A ZOMBIE' : '🏃 YOU ARE A SURVIVOR'}
        </Text>
        <Text style={styles.hudSubtext}>
          {isZombie
            ? 'Touch green survivors or get within 10m to infect them!'
            : 'Stay more than 10 meters away from red zombie circles!'}
        </Text>
        <Text style={styles.playerCount}>Total Players Connected: {allPlayers.length}</Text>
        
        <TouchableOpacity style={styles.rejoinButton} onPress={connectSocket}>
          <Text style={styles.rejoinText}>Rejoin Match (Roll 50/50)</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#111', padding: 20 },
  loadingText: { color: '#fff', marginTop: 12, fontSize: 14, textAlign: 'center' },
  errorContainer: { flex: 1, backgroundColor: '#1a0000', padding: 24, justifyContent: 'center' },
  errorTitle: { color: '#ff4444', fontSize: 20, fontWeight: 'bold', marginBottom: 12, textAlign: 'center' },
  errorScroll: { backgroundColor: '#111', padding: 12, borderRadius: 8, maxHeight: 400, borderWidth: 1, borderColor: '#440000' },
  errorText: { color: '#ff8888', fontFamily: 'monospace', fontSize: 12 },
  retryButton: { marginTop: 16, backgroundColor: '#c0392b', padding: 14, borderRadius: 8, alignItems: 'center' },
  retryText: { color: '#fff', fontWeight: 'bold', fontSize: 14 },
  hud: {
    position: 'absolute',
    top: 50,
    left: 16,
    right: 16,
    padding: 16,
    borderRadius: 14,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 6,
    elevation: 8,
  },
  hudZombie: { backgroundColor: 'rgba(144, 12, 63, 0.92)' },
  hudSurvivor: { backgroundColor: 'rgba(30, 132, 73, 0.92)' },
  hudTitle: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  hudSubtext: { color: '#eee', fontSize: 12, marginTop: 4, textAlign: 'center' },
  playerCount: { color: '#ddd', fontSize: 11, marginTop: 6, fontStyle: 'italic' },
  rejoinButton: {
    marginTop: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 8,
  },
  rejoinText: { color: '#fff', fontSize: 12, fontWeight: 'bold' },
});