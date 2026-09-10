// Language. English is the source: every key in the table below is the English string exactly as it
// is written at the call site, so a missing translation falls through to English instead of showing
// a key. Two ways in, sharing one table:
//
//   t`wave ${n} · score ${s}`   a tagged template. The key is the static parts joined by {}, so
//                               "wave {} · score {}", and the values slot back into the translation.
//   trDom(el)                   walks the text nodes of freshly-inserted markup. This is what covers
//                               the big hand-written HTML blocks (the controls sheet, the menus),
//                               where the translatable bits sit between <b> tags nobody should touch.
//
// The system language decides on the way in; a toggle in settings overrides it and is remembered.

export const LANGS = { en: 'English', zh: '中文' };

const DICT = {
  zh: {
    // ---- main menu ----
    'DOODLE DISTRICT': '涂鸦街区',
    'a scribbled survival shooter': '一款手绘的生存射击游戏',
    'START': '开始',
    'solo · survive the waves': '单人 · 挺过一波又一波',
    'PLAY ONLINE': '联机游戏',
    'free for all or squad survival · up to 10 players': '自由混战或组队生存 · 最多 10 人',
    'free for all or squad survival · up to 10 players on your network': '自由混战或组队生存 · 同一网络下最多 10 人',
    'best score: {}': '最高分：{}',
    'map': '地图',
    'checkpoints': '存档点',
    'WAVE {}': '第 {} 波',
    'DOODLE MEXICO': '涂鸦墨西哥',
    'THE UNDERCITY': '地下城区',
    'streets, rooftops and fire escapes': '街道、屋顶和消防梯',
    'flooded tunnels, shuttered shops and metro echoes': '积水隧道、卷帘店铺和地铁回声',
    'a sun-baked plaza · piñatas, tacos and mariachi': '烈日下的广场 · 皮纳塔、塔可和街头乐队',

    // ---- settings ----
    'SETTINGS': '设置',
    'sensitivity · field of view · aim · language': '灵敏度 · 视野 · 瞄准 · 语言',
    'CONFIG': '设置',
    'every knob is live · move one and the game moves with it': '所有选项即时生效 · 拖动滑块，画面立刻跟着变',
    'LOOK': '视角',
    'FEEL': '手感',
    'GAME': '游戏',
    'look sensitivity': '视角灵敏度',
    'how far the view turns per inch of mouse': '鼠标移动同样距离，视角转多少',
    'how far the view turns per inch of thumb': '手指划过同样距离，视角转多少',
    'aim sensitivity': '开镜灵敏度',
    'share of the above while sighted down a gun': '开镜时相对上面灵敏度的比例',
    'scope sensitivity': '狙击镜灵敏度',
    'share of the above through the sniper scope': '透过狙击镜时相对上面灵敏度的比例',
    'field of view': '视野范围',
    'wider sees more of the fight · narrower reads further down the street': '越大看得越广 · 越小看得越远',
    'invert vertical look': '反转垂直视角',
    'move speed while aiming': '开镜后的移动速度',
    '100% is full walking speed, the same as not aiming': '100% 就是正常步行速度，和不开镜一样',
    'aim assist': '瞄准辅助',
    'how hard the view leans toward what it thinks you meant': '视角向它认为你想打的目标偏多少',
    'screen shake': '画面震动',
    'how hard an explosion kicks the camera': '爆炸把镜头踹得多狠',
    'view bob': '走动晃动',
    'how much the view rocks as you run': '奔跑时视角摇晃的幅度',
    'music': '音乐',
    'bullet drop & travel time': '子弹下坠与飞行时间',
    '(solo · in a lobby the host decides)': '（单人有效 · 房间内由房主决定）',
    'difficulty': '难度',
    'how fast you heal and how long your legs last': '你回血有多快，腿能撑多久',
    'EASY': '简单',
    'MEDIUM': '普通',
    'HARD': '困难',
    'EXTREME': '极限',
    'heals fast · run forever': '回血快 · 可以一直跑',
    'heals slowly · legs get tired': '回血慢 · 腿会累',
    'heals late and slowly · short legs': '回血又晚又慢 · 腿力更短',
    'no healing at all · find a medkit': '完全不回血 · 只能找血包',
    'language': '语言',
    'RESET TO DEFAULTS': '恢复默认',
    'language and music stay as you left them': '语言和音乐保持你原来的选择',

    // ---- online ----
    'your name': '你的名字',
    'QUICK PLAY': '快速游戏',
    'jumps into an open public lobby, or opens one for you': '加入一个开放的公开房间，没有就为你开一个',
    'or': '或',
    'CREATE LOBBY': '创建房间',
    'public': '公开',
    'private · friends only': '私密 · 仅限好友',
    'have a code?': '有房间码？',
    'JOIN': '加入',
    'public lobbies': '公开房间',
    'REFRESH': '刷新',
    'REJOIN {}': '重新加入 {}',
    'BACK': '返回',
    'looking…': '搜索中…',
    'press refresh to look for open lobbies': '点刷新找找开放的房间',
    'hit QUICK PLAY to join a lobby': '点「快速游戏」进一个房间',
    'could not look: {}': '没能搜索：{}',
    "{}'s lobby": '{} 的房间',
    'someone': '某人',
    '{}/{} · in a match': '{}/{} · 对局中',
    'full': '已满',
    'type the code your friend gave you': '输入好友给你的房间码',
    'asking the host to start…': '正在请房主开始…',
    'opening a lobby…': '正在开房…',
    'connecting…': '连接中…',
    'no open lobbies · opening a public one for you…': '没有开放的房间 · 正在为你开一个公开房',

    // ---- lobby ----
    'LOBBY': '房间',
    'code': '房间码',
    'mode': '模式',
    'shots': '弹道',
    'FREE FOR ALL': '自由混战',
    'everyone against everyone · first to {}': '所有人互为敌人 · 先到 {} 分',
    'SQUAD SURVIVAL': '组队生存',
    'all of you against the waves · bigger the squad, bigger the waves': '你们一起对抗波次 · 人越多，敌人越多',
    'movement': '机动性',
    'MID': '中等',
    'everything, a little heavier': '全部身手都在 · 只是略微沉重',
    'feet matter · no second jump': '靠双脚走位 · 没有二段跳',
    'boots on the ground · no grapple, no dash': '脚踏实地 · 没有钩爪，没有冲刺',
    'no grapple in this match': '本局没有钩爪',
    'INSTANT': '瞬时命中',
    'a shot lands where you aimed, the moment you fire': '开枪即命中你瞄准的位置',
    'BALLISTIC': '真实弹道',
    'rounds fly and fall · lead them, hold over them': '子弹会飞行和下坠 · 记得提前量和抬枪',
    'squad survival · you against the page': '组队生存 · 你们对抗这张纸',
    'free for all · first to {}': '自由混战 · 先到 {} 分',
    '{} · {}/{} players': '{} · {}/{} 人',
    'this lobby is public: anyone can quick play in, or type the code': '这是公开房间：任何人都能快速游戏进来，或输入房间码',
    'private lobby: friends type this code under PLAY ONLINE → JOIN': '私密房间：好友在「联机游戏 → 加入」里输入这个房间码',
    'you': '你',
    ' (you)': '（你）',
    'START MATCH': '开始对局',
    'LEAVE': '离开',
    'anyone can start · {}': '任何人都能开始 · {}',
    'anyone can start · only the host picks the mode and map · {}': '任何人都能开始 · 只有房主能选模式和地图 · {}',
    'people can still join once it is running': '开始之后仍然可以加入',
    '{} players in': '已有 {} 人',

    // ---- pause / death / end of match ----
    'MENU': '菜单',
    'PAUSED': '已暂停',
    'MATCH ON': '对局进行中',
    'ERASED': '已被擦除',
    'MAIN MENU': '主菜单',
    'LEAVE MATCH': '退出对局',
    'free for all · lobby {}': '自由混战 · 房间 {}',
    'wave {} · score {}': '第 {} 波 · 得分 {}',
    'you survived <b>{}</b> wave{} · <b>{}</b> kills · score <b>{}</b>': '你挺过了 <b>{0}</b> 波 · <b>{2}</b> 击杀 · 得分 <b>{3}</b>',
    ' · <b>NEW BEST</b>': ' · <b>新纪录</b>',
    ' · best {}': ' · 最高 {}',
    'TAP TO {}': '点击{}',
    'CLICK ANYWHERE (or press {}) TO {}': '点击任意位置（或按 {}）{}',
    'KEEP PLAYING': '继续游戏',
    'RESUME': '继续',
    'PLAY': '开始',
    'DRAW AGAIN': '重新开画',
    'SQUAD WIPED': '小队全灭',
    'YOU WIN': '你赢了',
    '{} WINS': '{} 获胜',
    'you held the page to wave {} · {} points': '你们守住了这张纸，撑到第 {} 波 · {} 分',
    'back to the lobby in a moment…': '马上回到房间…',
    '{} kills · {} downs': '{} 击杀 · {} 倒地',
    '{} kills · {} deaths': '{} 击杀 · {} 死亡',
    '{} K · {} D': '{} 杀 · {} 死',
    'first to {}': '先到 {} 分',
    'first to {} · {} left · lobby {}': '先到 {} 分 · 剩 {} · 房间 {}',
    'wave {} · {} points · {} left · lobby {}': '第 {} 波 · {} 分 · 还剩 {} 个 · 房间 {}',

    // ---- controls sheet: mouse and keyboard ----
    'Mouse': '鼠标',
    'Both mouse buttons': '鼠标左右键',
    'both mouse buttons (or X)': '鼠标左右键（或 X）',
    '1-4 / wheel': '1-4 / 滚轮',
    'wheel': '滚轮',
    'L stick': '左摇杆',
    'R stick': '右摇杆',
    'R3 / d-pad up': 'R3 / 方向键上',
    'MOUSE + KEYBOARD': '鼠标 + 键盘',
    'move': '移动',
    'look': '视角',
    'sprint': '冲刺',
    'fire / slash': '开火 / 挥刀',
    'aim down sights / block': '开镜瞄准 / 格挡',
    'jump (again on a wall = wall jump)': '跳跃（贴墙再按 = 蹬墙跳）',
    'again in the air = double jump': '空中再按 = 二段跳',
    'slide on the ground · air dash in the air': '地面滑铲 · 空中冲刺',
    'grapple: tap to swing, hold to reel, jump to launch': '钩锁：轻点荡出，长按收绳，跳跃弹射',
    'quick katana slash': '快速刀击',
    'reload': '换弹',
    'grenade · hold it to throw further': '手雷 · 长按扔得更远',
    'scoreboard (online)': '计分板（联机）',
    'pause': '暂停',
    'dash-slash once the gauge is lit': '刀气充满后可冲刺斩',
    'rifle · shotgun · sniper · katana': '步枪 · 霰弹枪 · 狙击枪 · 武士刀',

    // ---- controls sheet: gamepad ----
    'PS5 CONTROLLER': 'PS5 手柄',
    'aim / block': '瞄准 / 格挡',
    'jump': '跳跃',
    'slide · air dash': '滑铲 · 空中冲刺',
    'grapple (hold to reel, ✕ to launch)': '钩锁（长按收绳，✕ 弹射）',
    'dash-slash once the katana gauge is lit': '刀气充满后可冲刺斩',
    'quick katana slash, then back to your gun': '快速刀击，随后自动换回枪',
    'next weapon': '下一把武器',
    'grenade · hold to throw further': '手雷 · 长按扔得更远',

    // ---- controls sheet: touch ----
    'FIRE': '开火',
    'AIM': '瞄准',
    'JUMP': '跳跃',
    'SLIDE': '滑铲',
    'HOOK': '钩索',
    'SLASH': '刀',
    'NADE': '手雷',
    'RELOAD': '换弹',
    'AIM + FIRE': '瞄准 + 开火',
    'quick katana ·': '快速刀击 ·',
    'the weapon numbers': '武器数字键',
    'THUMBS': '拇指',
    'BUTTONS': '按键',
    'Left half': '左半屏',
    'Right half': '右半屏',
    'drag to move · push all the way forward to sprint': '拖动移动 · 推到底冲刺',
    'drag to look around': '拖动转视角',
    'hold to shoot — drag off it to keep aiming while you do': '按住开火 —— 手指滑出去还能边打边瞄',
    'on the left edge fires too, for tracking with the other thumb': '左边缘也能开火，方便另一只手追瞄',
    'is a toggle: tap once to sight in, again to come out': '是开关：点一下开镜，再点一下退出',
    'again in the air = double jump · at a wall = wall jump': '空中再按 = 二段跳 · 贴墙 = 蹬墙跳',
    'on the ground · air dash in the air': '地面滑铲 · 空中冲刺',
    'tap to swing, hold to reel, JUMP to launch': '轻点荡出，长按收绳，跳跃弹射',
    'hold to throw further': '长按扔得更远',
    'along the bottom pick a weapon': '底部一排切换武器',
    'turn your phone sideways': '请把手机横过来',
    'push the stick forward': '把摇杆推到底',
    'tap the screen': '点击屏幕',

    // ---- hud ----
    'SCORE': '得分',
    'WAVE': '波次',
    'enemies left': '个敌人',
    'KATANA': '武士刀',
    'SLASH READY': '冲刺斩就绪',
    'grenades': '手雷',
    ' reloading…': ' 换弹中…',
    'combo x{}': '连击 x{}',
    'next wave in {}': '{} 秒后下一波',

    // ---- weapons ----
    'weapon mode': '武器模式',
    'NORMAL': '普通模式',
    'NO SNIPERS': '禁止狙击枪',
    'GRENADES ONLY': '仅限手雷',
    'KNIVES ONLY': '仅限刀战',
    'all weapons and grenades': '所有武器和手雷均可使用',
    'all weapons except the sniper rifle': '除狙击枪外，其余武器照常使用',
    'unlimited grenades - no guns or knives': '无限手雷 · 禁止枪械和刀',
    'katana only - no guns or grenades': '只能使用刀 · 禁止枪械和手雷',
    'GRENADES': '手雷',
    'THROW': '投掷',
    'unlimited grenades': '无限手雷',
    'hold fire or grenade to aim - release to throw': '按住攻击键或手雷键蓄力，松开投掷',
    'unlimited grenades - hold fire and release to throw': '无限手雷 · 按住攻击键蓄力，松开投掷',
    'RIFLE': '步枪',
    'SHOTGUN': '霰弹枪',
    'SNIPER': '狙击枪',
    'REVOLVER': '左轮',
    'ROCKET': '火箭筒',
    'auto · put the red dot on them': '全自动 · 把红点压在他们身上',
    'pump · devastating up close': '泵动 · 近距离毁灭性',
    'scoped bolt action · one shot, one erasure': '带镜栓动 · 一枪一个',
    'hand cannon · headshots erase': '手炮 · 爆头即抹除',
    'slash · hold aim to block & return bullets': '挥刀 · 按住瞄准键格挡并弹回子弹',
    'one tube · armour comes apart': '单发装填 · 装甲一炸就散',

    // ---- enemies ----
    'GRUNT': '杂兵',
    'RUSHER': '突进兵',
    'HEAVY': '重装兵',
    'INK BOMB': '墨水炸弹',
    'PAPER WASP': '纸黄蜂',
    'SHIELDBEARER': '持盾兵',
    'WARDEN': '铁卫',
    'SIEGE': '攻城兵',
    'THE DOODLER': '涂鸦者',
    'THE ERASER': '橡皮擦',
    'THE INKBLOT': '墨渍',
    '{} IS COMING': '{} 来了',

    // ---- waves, modifiers, tips ----
    'GET READY': '准备',
    'WAVE {} CLEARED': '第 {} 波已清场',
    'catch your breath': '喘口气',
    'catch your breath · +{}': '喘口气 · +{}',
    'CHECKPOINT · WAVE {}': '存档点 · 第 {} 波',
    'they are crawling off the page': '他们正从纸上爬出来',
    '{} of you · they come harder in a crowd': '你们有 {} 人 · 人多了他们也更凶',
    'CAFFEINATED · they move fast': '打了鸡血 · 他们跑得飞快',
    'HEAVY INK · they hit harder': '浓墨 · 他们打得更疼',
    'SWARM · more of them, thinner': '虫潮 · 数量更多，血更薄',
    'ink harder': '下笔再狠一点',
    'keep scribbling': '继续涂',
    'stay off the ground': '别落地',
    'swing for it': '荡起来',
    'return their bullets': '把子弹弹回去',
    'hold <b>{}</b> to reel in · tap it again to let go mid-swing': '按住 <b>{}</b> 收绳 · 荡到一半再点一下松手',
    'block with <b>{}</b> and some of their bullets go back at them': '用 <b>{}</b> 格挡，有些子弹会弹回去',
    'kills in the air are worth more · stay off the floor': '空中击杀分更高 · 别落地',
    '<b>{}</b> lobs a grenade · pickups give you more': '<b>{}</b> 扔手雷 · 补给里还能捡到',
    'press <b>{}</b> again in the air for a double jump': '空中再按一下 <b>{}</b> 就是二段跳',

    // ---- combat feed ----
    'READY': '准备',
    'click the page to grab the mouse': '点一下页面来锁定鼠标',
    'HEADSHOT': '爆头',
    'SLICED': '斩断',
    'CUT DOWN': '砍倒',
    'EXECUTED': '处决',
    'RETURN TO SENDER': '原路奉还',
    'FELL OFF THE PAGE': '掉出纸外',
    ' · AIRBORNE': ' · 滞空',
    'BLOCKED': '格挡',
    'PERFECT PARRY': '完美弹反',
    'YANKED': '拽过来',
    'SHIELD BROKEN': '破盾',
    'PIÑATA': '皮纳塔',
    'DEFLECTED': '弹开',
    'PARRIED': '弹反',
    'RETURNED': '弹回',
    'ROPE CUT': '绳子被割断',
    '+AMMO · +GRENADE': '+弹药 · +手雷',
    '+ROCKET LAUNCHER · SLOT 5': '+火箭筒 · 第 5 格',
    '+ROCKET ×2': '+火箭弹 ×2',
    'rocket launcher · slot 5 · armour comes apart': '火箭筒 · 第 5 格 · 装甲一炸就散',
    'armoured · explosives, the visor, or the pack on its back': '有装甲 · 上爆炸物、打面罩，或绕到背后打动力包',
    '+35 HP': '+35 生命',
    'TACO · +35 HP': '塔可 · +35 生命',
    'OFF THE PAGE': '掉出纸外',
    'redrawn at the start': '在起点重画',
    'out of breath · land to recover': '喘不上气 · 落地恢复',
    'out of breath · walk it off': '喘不上气 · 走一段缓一缓',
    'grapple needs a breather': '钩锁需要喘口气',
    'blocked · the dash did not reach': '被挡住了 · 冲刺没够到',
    'your rope got cut': '你的绳子被割断了',
    'spawn protection · 2s': '出生保护 · 2 秒',
    'STILL THERE?': '还在吗？',
    'move or you get kicked for inactivity': '动一动，不然会被判挂机踢出',
    'HOST LEFT': '房主离开了',
    'you are hosting now': '现在由你当房主',
    'someone else is hosting now': '现在换了别人当房主',
    'erased': '被抹除',
    'erased by {}{}': '被 {} 抹除{}',
    'ERASED {}{}': '抹除了 {}{}',
    '{} erased {}{}': '{} 抹除了 {}{}',
    '{} fell off the page': '{} 掉出了纸外',
    '{} fell off the page · -1': '{} 掉出了纸外 · -1',
    'fell off the page · -1 kill': '掉出纸外 · -1 击杀',
    '{} is down': '{} 倒下了',
    '{} joined': '{} 加入了',
    '{} left': '{} 离开了',
    '{} has gone quiet': '{} 没声了',
    '{} is back': '{} 回来了',
    '{} lost connection': '{} 掉线了',
    'the host has gone quiet': '房主没声了',
    'connection lost — reconnecting…': '连接断开 —— 正在重连…',
    'reconnected': '已重连',
    ' headshot': ' 爆头',
    'rifle': '步枪',
    'shotgun': '霰弹枪',
    'sniper': '狙击枪',
    'katana': '武士刀',
    'grenade': '手雷',
    'their own bullet': '他们自己的子弹',
    '<b>SLASH READY</b> · hold {} to dash': '<b>冲刺斩就绪</b> · 按住 {} 冲刺',
  },
};

const norm = (l) => (String(l || '').toLowerCase().startsWith('zh') ? 'zh' : 'en');

function detect() {
  try {
    const forced = /[?&]lang=([a-z-]+)/i.exec(location.search);
    if (forced) return norm(forced[1]);
    const saved = localStorage.getItem('doodle_lang');
    if (saved && LANGS[saved]) return saved;
    const nav = navigator.languages && navigator.languages.length ? navigator.languages[0] : navigator.language;
    return norm(nav);
  } catch (e) { return 'en'; }
}

let lang = detect();
let table = DICT[lang] || null;
const listeners = [];

export function getLang() { return lang; }
export function onLangChange(fn) { listeners.push(fn); }
export function setLang(l) {
  l = LANGS[l] ? l : 'en';
  if (l === lang) return;
  lang = l; table = DICT[l] || null;
  try { localStorage.setItem('doodle_lang', l); } catch (e) { /* private mode */ }
  try { document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en'; } catch (e) { /* no dom */ }
  for (const fn of listeners) fn(l);
}
try { document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'; } catch (e) { /* no dom */ }

// the raw lookup both entry points share: undefined means "say it in English"
const look = (k) => (table ? table[k] : undefined);

// fill {} left to right, or {0}/{1} where the translation needs a different order
function fill(s, vals) {
  if (!vals.length) return s;
  if (/\{\d\}/.test(s)) return s.replace(/\{(\d)\}/g, (m, i) => (vals[i] === undefined ? m : String(vals[i])));
  let i = 0;
  return s.replace(/\{\}/g, () => (i < vals.length ? String(vals[i++]) : ''));
}

// t`text ${value} more` - the key is "text {} more"
export function t(strings, ...vals) {
  const key = strings.raw.join('{}');
  const hit = look(key);
  if (hit === undefined) { let s = strings[0]; for (let i = 0; i < vals.length; i++) s += vals[i] + strings[i + 1]; return s; }
  return fill(hit, vals);
}

// for strings that arrive as values rather than literals (weapon names, a map's blurb)
export function ts(s, ...vals) { const hit = look(s); return hit === undefined ? fill(s, vals) : fill(hit, vals); }

// Walk everything under `el` and translate the text as it stands. Whitespace around a run is put
// back untouched, so " move &nbsp; " keeps its spacing and only the word changes. Nodes are matched
// whole: a phrase split across two <b> tags is two entries, which is what the tables above assume.
const SKIP = { SCRIPT: 1, STYLE: 1, INPUT: 1, TEXTAREA: 1 };
export function trDom(el) {
  if (!table || !el) return el;
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (SKIP[n.parentNode && n.parentNode.nodeName] ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const hits = [];
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const raw = n.nodeValue, body = raw.trim();
    if (!body) continue;
    const hit = look(body);
    if (hit === undefined) continue;
    hits.push([n, raw.slice(0, raw.indexOf(body)) + hit + raw.slice(raw.indexOf(body) + body.length)]);
  }
  for (const [n, v] of hits) n.nodeValue = v;
  for (const node of el.querySelectorAll('[placeholder], [title]')) {
    for (const a of ['placeholder', 'title']) {
      const v = node.getAttribute(a); if (!v) continue;
      const hit = look(v.trim()); if (hit !== undefined) node.setAttribute(a, hit);
    }
  }
  return el;
}

// same, for a markup string that has not been inserted yet
export function trHTML(html) {
  if (!table) return html;
  const box = document.createElement('div');
  box.innerHTML = html; trDom(box);
  return box.innerHTML;
}
