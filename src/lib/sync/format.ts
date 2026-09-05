const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** The counter's figure and its unit, chosen so a young product still reads
 *  as a number rather than as "0 hours". */
export function formatListened(totalSeconds: number): { figure: string; unit: string } {
  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    return { figure: integer.format(minutes), unit: minutes === 1 ? "minute" : "minutes" };
  }
  const hours = totalSeconds / 3600;
  if (hours < 100) return { figure: oneDecimal.format(Math.floor(hours * 10) / 10), unit: "hours" };
  return { figure: integer.format(Math.floor(hours)), unit: "hours" };
}

export function plural(count: number, one: string, many: string): string {
  return `${integer.format(count)} ${count === 1 ? one : many}`;
}

export const formatInteger = (value: number): string => integer.format(value);
