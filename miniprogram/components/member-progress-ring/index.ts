function ringImage(completed: number, total: number): string {
  const ratio = total > 0 ? Math.max(0, Math.min(1, completed / total)) : 0;
  const circumference = 2 * Math.PI * 25;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60" viewBox="0 0 60 60"><circle cx="30" cy="30" r="25" fill="none" stroke="#eeedf4" stroke-width="4"/><circle cx="30" cy="30" r="25" fill="none" stroke="#74629b" stroke-width="4" stroke-dasharray="${ratio * circumference} ${circumference}" transform="rotate(-90 30 30)"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

Component({
  options: { virtualHost: true, styleIsolation: "apply-shared" },
  properties: {
    completed: { type: Number, value: 0 },
    total: { type: Number, value: 0 },
  },
  data: { ring: ringImage(0, 0) },
  observers: {
    "completed, total"(completed: number, total: number) {
      const ring = ringImage(completed, total);
      if (ring !== this.data.ring) this.setData({ ring });
    },
  },
});
