export const openUrl = async (url: string) => {
  throw new Error(`Browser sign-in isn't available in the CLI (would open ${url}). Use the client-credentials grant, or pass a token with --var token=…`);
};
