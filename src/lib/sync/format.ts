const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** The counter's figure and its unit. Always minutes: the figure is what a
 *  visitor reads, and 3,500 minutes is a number where 59 hours is a shrug. */
export function formatListened(totalSeconds: number): { figure: string; unit: string } {
  const minutes = Math.floor(totalSeconds / 60);
  return { figure: integer.format(minutes), unit: minutes === 1 ? "minute" : "minutes" };
}

export function plural(count: number, one: string, many: string): string {
  return `${integer.format(count)} ${count === 1 ? one : many}`;
}

export const formatInteger = (value: number): string => integer.format(value);
