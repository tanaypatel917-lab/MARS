/** Lusion's preloader counter: each digit is two stacked glyphs translated by the fractional part of an eased value (1 - e^(-7·dt)). */
export class Odometer {
  private readonly columns: { top: HTMLElement; bottom: HTMLElement; value: number }[] = [];
  private target = 0;
  constructor(private readonly host: HTMLElement, digits: number) {
    host.classList.add('odometer');
    host.innerHTML = '';
    for (let i = 0; i < digits; i++) {
      const col = document.createElement('span');
      col.className = 'digit';
      col.innerHTML = '<i>0</i><i>1</i>';
      host.append(col);
      this.columns.push({ top: col.children[0] as HTMLElement, bottom: col.children[1] as HTMLElement, value: 0 });
    }
  }
  set(value: number) { this.target = Math.max(0, Math.round(value)); }
  snap(value: number) { this.set(value); for (const c of this.columns) c.value = NaN; this.update(1); }
  update(dt: number) {
    const k = 1 - Math.exp(-7 * dt);
    const text = String(this.target).padStart(this.columns.length, '0').slice(-this.columns.length);
    this.columns.forEach((col, i) => {
      const goal = Number(text[i]);
      if (Number.isNaN(col.value)) col.value = goal;
      let delta = goal - col.value;
      if (delta < -5) delta += 10; if (delta > 5) delta -= 10;
      col.value = (col.value + delta * k + 10) % 10;
      if (Math.abs(delta) < .002) col.value = goal;
      const floor = Math.floor(col.value), frac = col.value - floor;
      col.top.textContent = String(floor);
      col.bottom.textContent = String((floor + 1) % 10);
      col.top.style.transform = `translateY(${-frac * 100}%)`;
      col.bottom.style.transform = `translateY(${(1 - frac) * 100}%)`;
    });
    this.host.setAttribute('aria-label', text);
  }
}
