// Mock expo-server-sdk for Jest (ESM → CJS stub)
class Expo {
  constructor() {}
  chunkPushNotifications(msgs) { return [msgs]; }
  async sendPushNotificationsAsync() { return []; }
  static isExpoPushToken(t) { return typeof t === 'string' && t.startsWith('ExponentPushToken'); }
}
module.exports = { Expo };
module.exports.default = { Expo };
