/** A quiet generated drone so the sound toggle is real without shipping an audio file. */
export class Ambient {
  private context?: AudioContext;
  private gain?: GainNode;
  private nodes: AudioNode[] = [];
  get on() { return !!this.context && this.context.state === 'running' && (this.gain?.gain.value ?? 0) > 0; }
  async start() {
    if (!this.context) {
      this.context = new AudioContext();
      this.gain = this.context.createGain();
      this.gain.gain.value = 0;
      this.gain.connect(this.context.destination);
      for (const [frequency, level] of [[55, .05], [55.4, .04], [110.3, .015], [164.6, .006]]) {
        const oscillator = this.context.createOscillator();
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;
        const gain = this.context.createGain();
        gain.gain.value = level;
        oscillator.connect(gain).connect(this.gain);
        oscillator.start();
        this.nodes.push(oscillator, gain);
      }
      const seconds = 4;
      const buffer = this.context.createBuffer(1, this.context.sampleRate * seconds, this.context.sampleRate);
      const data = buffer.getChannelData(0);
      let last = 0;
      for (let i = 0; i < data.length; i++) { last = last * .985 + (Math.random() * 2 - 1) * .015; data[i] = last; }
      const noise = this.context.createBufferSource();
      noise.buffer = buffer;
      noise.loop = true;
      const filter = this.context.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 380;
      const noiseGain = this.context.createGain();
      noiseGain.gain.value = .5;
      noise.connect(filter).connect(noiseGain).connect(this.gain);
      noise.start();
      this.nodes.push(noise, filter, noiseGain);
    }
    await this.context.resume();
    this.gain!.gain.setTargetAtTime(.9, this.context.currentTime, 1.2);
  }
  stop() {
    if (!this.context || !this.gain) return;
    this.gain.gain.setTargetAtTime(0, this.context.currentTime, .4);
  }
  dispose() {
    for (const node of this.nodes) if ('stop' in node) (node as AudioScheduledSourceNode).stop();
    void this.context?.close();
    this.context = undefined;
  }
}
