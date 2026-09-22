/**
 * PropertyChannel — generic eased value container.
 *
 * Replaces all ad-hoc lerping across the codebase. One system, one easing model.
 * Set a target, call update(dt) each frame, read current.
 */

export class PropertyChannel {
  current: number;
  target: number;
  speed: number;   // fraction per second (e.g., 3.0 = reaches ~95% in 1s)

  constructor(initial = 0, speed = 3) {
    this.current = initial;
    this.target = initial;
    this.speed = speed;
  }

  setTarget(value: number, speed?: number): void {
    this.target = value;
    if (speed !== undefined) this.speed = speed;
  }

  snap(value: number): void {
    this.current = value;
    this.target = value;
  }

  update(dt: number): number {
    if (this.current === this.target) return this.current;
    // Exponential ease: current += (target - current) * (1 - e^(-speed*dt))
    const factor = 1 - Math.exp(-this.speed * dt);
    this.current += (this.target - this.current) * factor;
    // Snap when close enough to avoid infinite asymptotic crawl
    if (Math.abs(this.target - this.current) < 0.0001) {
      this.current = this.target;
    }
    return this.current;
  }
}

/**
 * Vec3Channel — three PropertyChannels for positions, colors, etc.
 */
export class Vec3Channel {
  x: PropertyChannel;
  y: PropertyChannel;
  z: PropertyChannel;

  constructor(x = 0, y = 0, z = 0, speed = 3) {
    this.x = new PropertyChannel(x, speed);
    this.y = new PropertyChannel(y, speed);
    this.z = new PropertyChannel(z, speed);
  }

  setTarget(x: number, y: number, z: number, speed?: number): void {
    this.x.setTarget(x, speed);
    this.y.setTarget(y, speed);
    this.z.setTarget(z, speed);
  }

  snap(x: number, y: number, z: number): void {
    this.x.snap(x);
    this.y.snap(y);
    this.z.snap(z);
  }

  update(dt: number): [number, number, number] {
    return [this.x.update(dt), this.y.update(dt), this.z.update(dt)];
  }

  get current(): [number, number, number] {
    return [this.x.current, this.y.current, this.z.current];
  }
}
