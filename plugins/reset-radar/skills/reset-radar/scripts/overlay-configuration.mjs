import { readConfiguration } from './api-client.mjs';
import { configureKey, loadConfiguration } from './configuration.mjs';

function configurationError(code, message) {
  return Object.assign(new Error(message), {code});
}

export async function saveOverlayKey(key, environment = process.env) {
  if (environment.RESET_RADAR_API_KEY !== undefined) {
    throw configurationError('OVERLAY_KEY_ENV_OVERRIDE',
      '当前 Key 由环境变量提供。请先移除 RESET_RADAR_API_KEY 环境变量，再在此保存。');
  }
  try {
    if (typeof key !== 'string' || key.length > 512) throw new Error();
    // Validate the complete configuration before replacing an existing private file.
    readConfiguration({...environment, RESET_RADAR_API_KEY:key});
  } catch {
    throw configurationError('OVERLAY_KEY_INVALID',
      'API Key 或本机接口配置不正确，请检查后重试。');
  }
  try {
    await configureKey([key], environment);
    return await loadConfiguration(environment);
  } catch {
    // Filesystem errors can include private paths; never forward the original error.
    throw configurationError('OVERLAY_KEY_SAVE_FAILED',
      '无法保存 API Key，请检查本机配置目录的写入权限后重试。');
  }
}
