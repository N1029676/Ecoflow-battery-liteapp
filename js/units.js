// Temperatures arrive and are stored in degrees Celsius; everything shown to the user is Fahrenheit.
export const cToF = (c) => (c == null || Number.isNaN(c) ? null : c * 9 / 5 + 32);
