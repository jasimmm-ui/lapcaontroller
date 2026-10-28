const allowed = new Set(['mouse.move','mouse.click','mouse.rightClick','mouse.doubleClick','mouse.scroll','keyboard.text','keyboard.key','keyboard.shortcut','media.playPause','media.previous','media.next','volume.up','volume.down','volume.mute','app.launch']);
const keys = new Set(['ENTER','BACKSPACE','TAB','ESCAPE','ARROWUP','ARROWDOWN','ARROWLEFT','ARROWRIGHT','SPACE','DELETE']);
const shortcuts = new Set(['CTRL+C','CTRL+V','ALT+TAB','WIN+D']);
const apps = new Set(['notepad','calculator','explorer']);
const hasOnly = (value, keys) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export function validateCommand(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.command !== 'string' || !allowed.has(body.command)) return false;
  const { command, ...p } = body;
  switch (command) {
    case 'mouse.move': return hasOnly(p,['dx','dy']) && Number.isFinite(p.dx) && Number.isFinite(p.dy) && Math.abs(p.dx) <= 1000 && Math.abs(p.dy) <= 1000;
    case 'mouse.scroll': return hasOnly(p,['delta']) && Number.isFinite(p.delta) && Math.abs(p.delta) <= 5000;
    case 'keyboard.text': return hasOnly(p,['text']) && typeof p.text === 'string' && p.text.length <= 1000;
    case 'keyboard.key': return hasOnly(p,['key']) && typeof p.key === 'string' && keys.has(p.key.toUpperCase());
    case 'keyboard.shortcut': return hasOnly(p,['shortcut']) && typeof p.shortcut === 'string' && shortcuts.has(p.shortcut.toUpperCase());
    case 'app.launch': return hasOnly(p,['app']) && typeof p.app === 'string' && apps.has(p.app);
    default: return Object.keys(p).length === 0;
  }
}
