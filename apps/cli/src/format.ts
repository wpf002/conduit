import pc from 'picocolors';

export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? '').length)),
  );
  const line = (cells: readonly string[]) =>
    cells.map((cell, i) => (cell ?? '').padEnd(widths[i]!)).join('  ').trimEnd();

  return [
    pc.bold(line(headers)),
    pc.dim(widths.map((w) => '-'.repeat(w)).join('  ')),
    ...rows.map(line),
  ].join('\n');
}

export function statusLabel(status: string): string {
  switch (status) {
    case 'ok':
      return pc.green('ok');
    case 'near_ceiling':
      return pc.yellow('near ceiling');
    case 'no_entitlement':
      return pc.yellow('no entitlement');
    case 'rate_limited':
      return pc.yellow('rate limited');
    case 'silent':
      return pc.red('silent');
    case 'auth_failed':
      return pc.red('auth failed');
    case 'unreachable':
      return pc.red('unreachable');
    default:
      return pc.dim(status);
  }
}

/** Integer micro-units to a display string. Never used for arithmetic. */
export function money(costMicro: number): string {
  const sign = costMicro < 0 ? '-' : '';
  const abs = Math.abs(costMicro);
  return `${sign}$${Math.trunc(abs / 1_000_000)}.${(abs % 1_000_000).toString().padStart(6, '0')}`;
}

export function ms(value: number | undefined): string {
  return value === undefined ? '-' : `${value}ms`;
}
