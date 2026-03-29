import { useEffect, useRef } from 'react'
import { Animated, StyleSheet } from 'react-native'

export function PulsingDot({ online }: { online: boolean }) {
  const opacity = useRef(new Animated.Value(1)).current

  useEffect(() => {
    if (online) {
      const anim = Animated.loop(
        Animated.sequence([
          Animated.timing(opacity, { toValue: 0.4, duration: 1500, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 1, duration: 1500, useNativeDriver: true }),
        ])
      )
      anim.start()
      return () => anim.stop()
    } else {
      opacity.setValue(1)
    }
  }, [online])

  return (
    <Animated.View
      style={[
        styles.dot,
        online ? styles.online : styles.offline,
        online && { opacity },
      ]}
    />
  )
}

const styles = StyleSheet.create({
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  online: {
    backgroundColor: '#34d399',
  },
  offline: {
    backgroundColor: '#ef4444',
  },
})
