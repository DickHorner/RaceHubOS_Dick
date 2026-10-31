// Locally synthesised motor/air texture. No recordings, streams or downloaded assets.
export function createRaceAmbience() {
  const AudioContext = window.AudioContext || window.webkitAudioContext
  const context = new AudioContext()
  const sources = []
  let closed = false
  let master
  let target = 0
  const stop = () => {
    if (closed) return
    closed = true
    for (const source of sources) {
      try {
        source.stop()
        source.disconnect()
      } catch {
        /* A partially constructed source may not have started. */
      }
    }
    master?.disconnect()
    context.close().catch(() => {})
  }
  try {
    master = context.createGain()
    master.gain.value = 0
    master.connect(context.destination)
    const motor = context.createGain()
    motor.gain.value = 0.16
    const lowpass = context.createBiquadFilter()
    lowpass.type = 'lowpass'
    lowpass.frequency.value = 750
    motor.connect(lowpass).connect(master)
    const modulation = context.createOscillator()
    modulation.frequency.value = 0.07
    const depth = context.createGain()
    depth.gain.value = 18
    modulation.connect(depth)
    sources.push(modulation)
    modulation.start()
    for (const frequency of [98, 195]) {
      const oscillator = context.createOscillator()
      oscillator.type = 'sawtooth'
      oscillator.frequency.value = frequency
      depth.connect(oscillator.frequency)
      oscillator.connect(motor)
      sources.push(oscillator)
      oscillator.start()
    }
    const buffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate)
    const samples = buffer.getChannelData(0)
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1
    const air = context.createBufferSource()
    air.buffer = buffer
    air.loop = true
    const airFilter = context.createBiquadFilter()
    airFilter.type = 'bandpass'
    airFilter.frequency.value = 400
    const airGain = context.createGain()
    airGain.gain.value = 0.04
    air.connect(airFilter).connect(airGain).connect(master)
    sources.push(air)
    air.start()
    return {
      get state() {
        return context.state
      },
      async resume() {
        let timeout
        try {
          await Promise.race([
            context.resume(),
            new Promise((_, reject) => {
              timeout = setTimeout(() => reject(new Error('Audio resume timed out')), 4000)
            }),
          ])
          if (context.state !== 'running') throw new Error('Audio context is not running')
        } finally {
          clearTimeout(timeout)
        }
      },
      setVolume(value) {
        if (closed || value === target) return
        target = value
        master.gain.setTargetAtTime(value, context.currentTime, 0.04)
      },
      stop,
    }
  } catch (error) {
    stop()
    throw error
  }
}
