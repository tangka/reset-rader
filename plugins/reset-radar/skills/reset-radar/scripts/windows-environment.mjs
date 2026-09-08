// Native UI and file helpers need system paths, not the caller's credentials.
const systemNames = ['SystemRoot', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA'];

export function windowsSystemEnvironment(environment = process.env) {
  const result = {};
  for (const name of systemNames) {
    const key = Object.keys(environment).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    if (key !== undefined && typeof environment[key] === 'string') result[name] = environment[key];
  }
  return result;
}
