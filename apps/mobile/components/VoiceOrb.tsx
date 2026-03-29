import { useEffect, useRef } from 'react'
import { View, Animated, Easing, StyleSheet } from 'react-native'

export type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking'

const BAR_COUNT = 5
const BAR_WIDTH = 6
const BAR_GAP = 6
const MAX_HEIGHT = 80
const MIN_HEIGHT = 12

const STATE_COLORS: Record<VoiceState, string> = {
  idle: '#d4d4d8',
  listening: '#18181b',
  thinking: '#3b82f6',
  speaking: '#10b981',
}

export function VoiceOrb({ state }: { state: VoiceState }) {
  const barAnims = useRef(
    Array.from({ length: BAR_COUNT }, () => new Animated.Value(0.2))
  ).current

  const spinAnim = useRef(new Animated.Value(0)).current
  const loopsRef = useRef<Animated.CompositeAnimation[]>([])

  useEffect(() => {
    // Stop all previous animations
    loopsRef.current.forEach(a => a.stop())
    loopsRef.current = []

    if (state === 'idle') {
      // Gentle idle wave
      barAnims.forEach((anim, i) => {
        const loop = Animated.loop(
          Animated.sequence([
            Animated.timing(anim, {
              toValue: 0.15 + Math.sin(i * 1.2) * 0.1,
              duration: 800 + i * 100,
              easing: Easing.inOut(Easing.sin),
              useNativeDriver: false,
            }),
            Animated.timing(anim, {
              toValue: 0.3 + Math.sin(i * 0.8) * 0.1,
              duration: 800 + i * 100,
              easing: Easing.inOut(Easing.sin),
              useNativeDriver: false,
            }),
          ])
        )
        loop.start()
        loopsRef.current.push(loop)
      })
    } else if (state === 'listening') {
      // Active wave — bars dance at different speeds
      barAnims.forEach((anim, i) => {
        const variation = [0.7, 1.0, 0.85, 1.0, 0.65][i]
        const loop = Animated.loop(
          Animated.sequence([
            Animated.timing(anim, {
              toValue: 0.4 + variation * 0.5,
              duration: 300 + i * 60,
              easing: Easing.inOut(Easing.sin),
              useNativeDriver: false,
            }),
            Animated.timing(anim, {
              toValue: 0.15 + variation * 0.15,
              duration: 300 + i * 60,
              easing: Easing.inOut(Easing.sin),
              useNativeDriver: false,
            }),
          ])
        )
        loop.start()
        loopsRef.current.push(loop)
      })
    } else if (state === 'thinking') {
      // Slow pulse — all bars breathe together
      barAnims.forEach((anim, i) => {
        const loop = Animated.loop(
          Animated.sequence([
            Animated.timing(anim, {
              toValue: 0.5,
              duration: 600,
              delay: i * 80,
              easing: Easing.inOut(Easing.sin),
              useNativeDriver: false,
            }),
            Animated.timing(anim, {
              toValue: 0.15,
              duration: 600,
              easing: Easing.inOut(Easing.sin),
              useNativeDriver: false,
            }),
          ])
        )
        loop.start()
        loopsRef.current.push(loop)
      })
    } else if (state === 'speaking') {
      // Fast rhythmic bars
      barAnims.forEach((anim, i) => {
        const variation = [0.8, 1.0, 0.9, 1.0, 0.7][i]
        const loop = Animated.loop(
          Animated.sequence([
            Animated.timing(anim, {
              toValue: 0.3 + variation * 0.6,
              duration: 200 + i * 40,
              easing: Easing.inOut(Easing.sin),
              useNativeDriver: false,
            }),
            Animated.timing(anim, {
              toValue: 0.1 + variation * 0.1,
              duration: 200 + i * 40,
              easing: Easing.inOut(Easing.sin),
              useNativeDriver: false,
            }),
          ])
        )
        loop.start()
        loopsRef.current.push(loop)
      })
    }

    return () => {
      loopsRef.current.forEach(a => a.stop())
    }
  }, [state])

  const color = STATE_COLORS[state]
  const totalWidth = BAR_COUNT * BAR_WIDTH + (BAR_COUNT - 1) * BAR_GAP

  return (
    <View style={[styles.container, { width: totalWidth }]}>
      {barAnims.map((anim, i) => {
        const height = anim.interpolate({
          inputRange: [0, 1],
          outputRange: [MIN_HEIGHT, MAX_HEIGHT],
        })
        return (
          <Animated.View
            key={i}
            style={[
              styles.bar,
              {
                backgroundColor: color,
                height,
                width: BAR_WIDTH,
                opacity: state === 'idle' ? 0.5 : 1,
              },
            ]}
          />
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: MAX_HEIGHT,
    gap: BAR_GAP,
  },
  bar: {
    borderRadius: 3,
  },
})
