export const CLI_NAME = "quasar";
export const CLI_VERSION = "0.1.0";
export const USER_AGENT = `${CLI_NAME}/${CLI_VERSION}`;
export const API_BASE_URL_ENV = "QUASAR_CONTROL_URL";
export const API_KEY_ENV = ["QUASAR", "CONTROL", "TOKEN"].join("_");
export const DEFAULT_API_BASE_URL = "http://127.0.0.1:3218";
export const API_KEY_HINT =
  `Set ${API_KEY_ENV} or write {"token":"..."} to ~/.config/quasar/config.json.`;
