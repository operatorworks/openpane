export type Appearance = 'light' | 'dark';

const lightColors = {
  canvas: '#f8f9fb', surface: '#ffffff', raised: '#f0f2f5',
  text: '#20242c', muted: '#596273', border: '#dce1e9', controlBorder: '#737e90',
  accent: '#3655c7', onAccent: '#ffffff', danger: '#b42338', onDanger: '#ffffff', focus: '#3655c7',
};
export type ThemeColors = Readonly<Record<keyof typeof lightColors, string>>;
export const palettes: Readonly<Record<Appearance, ThemeColors>> = {
  light: lightColors,
  dark: {
    canvas: '#15171c', surface: '#1d2027', raised: '#292e38',
    text: '#eef0f5', muted: '#adb6c6', border: '#3c4350', controlBorder: '#8793a8',
    accent: '#a9b9ff', onAccent: '#17214b', danger: '#ffacb8', onDanger: '#47111b', focus: '#a9b9ff',
  },
};
