'use strict';

game.import('extension', function (lib, game, ui, get, ai, _status) {
	return {
		name: '复盘工具',
		editable: false,
		content: function (config, pack) {

			/* ================= 0. 状态 ================= */
			var HF = window.hfTool = {
				open: false, btn: null, panel: null, tab: 'start', timer: null,
				start: null,       // 起点快照
				stat: null,        // 当前区间统计
				records: [],       // 已保存记录
				picked: [],        // 选中对比的记录下标
				restoring: false,  // 还原中：暂停统计
				seqId: 0
			};
			/* ============ 配置 ============ */
			var CFG_KEY = 'hf_cfg';
			HF.cfg = {
				/* 起点栏开关：首次安装的默认值全是"关"。已装的用户不受影响 —— localStorage 里存过的值优先 */
				pileBar: false,    /* 右上角牌堆分类浮标 */
				addMode: 'virtual',/* 加牌方式：virtual 虚拟牌 / pile 从牌堆取 */
				showHand: false,   /* 拆顺明牌：看对方手牌时按真实牌面列出 */
				autoClose: true,   /* 记录/回到起点后自动收起面板（不是开关按钮） */
				autoSnap: false,   /* 自己回合开始时自动留一个快照 */
				askOver: false,    /* 对局即将结束前先询问要不要回溯 */
				bubblePin: false,  /* 气泡常驻：泡泡一直贴在屏幕上，单击球不再开合它们 */
				autoName: false,   /* 默认命名：存记录时直接叫 ① ② ③…，不弹命名框 */
			};
			function loadCfg() {
				try {
					var o = JSON.parse(localStorage.getItem(CFG_KEY) || '{}');
					for (var k in HF.cfg) {
						if (Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined && o[k] !== null) { HF.cfg[k] = o[k]; }
					}
				} catch (e) { }
			}
			function saveCfg() {
				try { localStorage.setItem(CFG_KEY, JSON.stringify(HF.cfg)); } catch (e) { }
			}
			function setCfg(k, v) {
				HF.cfg[k] = v;
				saveCfg();
				if (k === 'showHand') { applyHandTag(); }
				if (k === 'pileBar') { showPileBar(!!v); }
				if (k === 'bubblePin') {
					/* 开了就立刻把泡泡摊开并常驻；关了强制收起（closeBubbles 平时会被常驻挡住，所以给 true） */
					try { if (v) { if (HF.openBubbles) { HF.openBubbles(); } } else { if (HF.closeBubbles) { HF.closeBubbles(true); } } } catch (e) { }
				}
			}
			function showPileBar(on) {
				try {
					if (!on) { if (HF.pileBar) { HF.pileBar.style.display = 'none'; } return; }
					if (!HF.pileBar) { buildPileBar(); }
					if (HF.pileBar) { HF.pileBar.style.display = 'block'; refreshPileBar(); }
				} catch (e) { }
			}
			loadCfg();

			/* ================= 1. 小工具 ================= */
			function T(x) { try { return x == null ? '' : (get.translation(x) || String(x)); } catch (e) { return String(x); } }
			function PN(p) { if (!p) return '?'; return T(p.name1 || p.name) + (p.name2 ? '/' + T(p.name2) : ''); }
			function SEAT(p) { try { return parseInt(p.dataset.position); } catch (e) { return -1; } }
			function allP() { return (game.players || []).concat(game.dead || []); }
			function bySeat(s) { var l = allP(); for (var i = 0; i < l.length; i++) { if (SEAT(l[i]) === s) return l[i]; } return null; }
			function isMine(p) { return game.me && (p === game.me); }
			function rel(p) { return isMine(p) ? '我' : PN(p); }
			function shallow(o) { var r = {}, k; for (k in (o || {})) { r[k] = o[k]; } return r; }
			function forEach(list, fn) { for (var i = 0; i < list.length; i++) { fn(list[i], i); } }
			function playerByName(nm) {
				var found = null;
				try { allP().forEach(function (p) { if (PN(p) === nm) { found = p; } }); } catch (e) { }
				return found;
			}
			function fmt1(n) { var v = Math.round((n || 0) * 10) / 10; return String(v); }
			/* 伤害用红色 -N，失去手牌用灰色 -N */
			function dmgTxt(n) { return '<span style="color:#FF453A;font-weight:600">-' + n + '</span>'; }
			function loseTxt(n) { return '<span style="color:rgba(235,235,245,.45)">-' + n + '</span>'; }
			/* 属性前缀（火杀 / 雷杀）：本体里卡牌的 name 是 sha，属性单独存在 nature 上 */
			var NATURE_TEXT = { fire: '火', thunder: '雷', ice: '冰', poison: '毒', normal: '', none: '' };
			function cardName(c) {
				try {
					var n = T(c.name || c.viewAs || (c.cards && c.cards[0] && c.cards[0].name) || '?');
					var nat = c.nature;
					if (nat && NATURE_TEXT[nat]) { n = NATURE_TEXT[nat] + n; }
					return n;
				} catch (e) { return '?'; }
			}
			function handText(p) { return p.getCards('h').map(cardName).join(' '); }
			function nowText() { var d = new Date(); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2); }
			function phaseText() { try { return '第' + (game.roundNumber || 1) + '轮/' + ((_status.currentPhase && _status.currentPhase.phaseNumber) || 0) + '回合'; } catch (e) { return ''; } }

						/* 卡牌搬家：直接改 DOM（无名杀里牌的位置＝父节点），不触发事件。
			   注意：本体动画搬牌（goto）会在牌上留 timeout/destiny/removing，必须 fix() 清干净，
			   否则 get.position / getCards("h") 会认错位置（牌变暗、点不动）。 */
			function moveCard(card, node) {
				try {
					if (!node || !card) return;
					prepCard(card);
					node.appendChild(card);
				} catch (e) { }
			}
			function giveCards(p, cards) {
				if (!cards || !cards.length) return;
				try { p.directgain(cards.slice(0), false); } catch (e) { }
				/* directgain 会给自己的手牌加 drawinghidden（等摸牌动画移除），这里直接撤掉，避免牌看不见 */
				for (var i = 0; i < cards.length; i++) { try { cards[i].classList.remove("drawinghidden"); } catch (e) { } }
				try { ui.updatehl(); } catch (e) { }
			}
			function equipCards(p, cards) {
				if (!cards || !cards.length) return;
				try { p.directequip(cards.slice(0)); } catch (e) { }
			}
			function toDiscard(cards) {
				if (!cards || !cards.length) return;
				var pile = ui.discardPile || ui.ordering;
				for (var i = 0; i < cards.length; i++) { moveCard(cards[i], pile); }
			}

			/* ================= 2. 快照 / 还原 ================= */
			function snapshotMarks(p) {
				/* 数字/字符串/布尔/数组/纯对象都要存：像 counttrigger（每回合限一次计数）是对象，
				   只存基本类型就会漏掉，"逆固"这类 usable 技能还原后仍算已用过 */
				var out = {};
				try {
					for (var k in p.storage) {
						if (!Object.prototype.hasOwnProperty.call(p.storage, k)) { continue; }
						var v = p.storage[k], tv = typeof v;
						if (tv === 'number' || tv === 'string' || tv === 'boolean') { out[k] = v; }
						else if (v === null) { out[k] = null; }
						else if (Array.isArray(v)) { out[k] = v.slice(0); }
						else if (tv === 'object' && Object.prototype.toString.call(v) === '[object Object]') { out[k] = shallow(v); }
					}
				} catch (e) { }
				return out;
			}
			/* 容器里的牌（按 DOM 顺序，牌堆第一个子节点＝牌堆顶） */
			function nodeList(node) {
				var r = [];
				try { for (var i = 0; i < node.childNodes.length; i++) { r.push(node.childNodes[i]); } } catch (e) { }
				return r;
			}
			/* 行动历史 */
			function historyState(p) {
				var out = { len: 0, last: null, gLen: 0, gLast: null };
				try {
					out.len = (p.actionHistory || []).length;
					var cur = p.actionHistory[out.len - 1];
					if (cur) {
						var lens = {};
						for (var k in cur) {
							if (Object.prototype.hasOwnProperty.call(cur, k) && Array.isArray(cur[k])) { lens[k] = cur[k].length; }
						}
						out.last = lens;
					}
				} catch (e) { }
				try {
					var g = _status.globalHistory || [];
					out.gLen = g.length;
					var gcur = g[g.length - 1];
					if (gcur) {
						var glens = {};
						for (var k2 in gcur) {
							if (Object.prototype.hasOwnProperty.call(gcur, k2) && Array.isArray(gcur[k2])) { glens[k2] = gcur[k2].length; }
						}
						out.gLast = glens;
					}
				} catch (e) { }
				return out;
			}
			function syncHistory(p, h) {
				try {
					if (!h) { return; }
					if ((p.actionHistory || []).length > h.len) { p.actionHistory.length = h.len; }
					var cur = p.actionHistory[p.actionHistory.length - 1];
					if (cur && h.last) {
						for (var k in h.last) {
							if (Array.isArray(cur[k]) && cur[k].length > h.last[k]) { cur[k].length = h.last[k]; }
						}
					}
				} catch (e) { }
			}
			function syncGlobalHistory(h) {
				try {
					if (!h) { return; }
					var g = _status.globalHistory || [];
					if (g.length > h.gLen) { g.length = h.gLen; }
					var cur = g[g.length - 1];
					if (cur && h.gLast) {
						for (var k in h.gLast) {
							if (Array.isArray(cur[k]) && cur[k].length > h.gLast[k]) { cur[k].length = h.gLast[k]; }
						}
					}
				} catch (e) { }
			}
			function statList(p) {
				var out = [];
				try {
					for (var i = 0; i < (p.stat || []).length; i++) {
						var r = p.stat[i] || {};
						out.push({
							skill: shallow(r.skill), card: shallow(r.card),
							damage: r.damage, damaged: r.damaged, gain: r.gain, kill: r.kill
						});
					}
				} catch (e) { }
				return out;
			}
			function snapshot() {
				var snap = { time: Date.now(), label: phaseText(), players: [], pile: [], discard: [] };
				allP().forEach(function (p) {
					try {
						var s = p.getStat() || {};
						var n = p.node || {};
						snap.players.push({
							seat: SEAT(p), name: PN(p),
							alive: !(p.isDead && p.isDead()),
							hp: p.hp, maxHp: p.maxHp,
							hand: p.getCards("h").slice(0),
							/* 分容器记录 */
							hand1: n.handcards1 ? nodeList(n.handcards1) : [],
							hand2: n.handcards2 ? nodeList(n.handcards2) : [],
							equip: n.equips ? nodeList(n.equips) : [],
							judge: n.judges ? nodeList(n.judges) : [],
							expand: n.expansions ? nodeList(n.expansions) : [],
							linked: !!p.isLinked(), turned: !!(p.isTurnedOver && p.isTurnedOver()),
							/* 移出游戏 */
							out: !!(p.isOut && p.isOut()), outCount: p.outCount || 0, outSkills: copyArr(p.outSkills),
							skills: (p.skills || []).slice(0),
							hidden: (p.hiddenSkills || []).slice(0),
							invisible: (p.invisibleSkills || []).slice(0),
							tempSkills: shallow(p.tempSkills),
							/* 限定技/觉醒技"已用"、额外技能、被禁用技能、跳过阶段也都算局面状态 */
							awakened: copyArr(p.awakenedSkills),
							skipList: copyArr(p.skipList),
							additional: copySkillMap(p.additionalSkills),
							disabled: copySkillMap(p.disabledSkills),
							forbidden: copySkillMap(p.forbiddenSkills),
							markList: markKeys(p),
							marks: snapshotMarks(p),
							hist: historyState(p),
							statLen: (p.stat || []).length,
							statSkill: shallow(p.getStat("skill")),
							statCard: shallow(p.getStat("card")),
							statNum: { damage: s.damage, damaged: s.damaged, gain: s.gain, kill: s.kill },
							statAll: statList(p)
						});
					} catch (e) { }
				});
				if (ui.cardPile) { snap.pile = nodeList(ui.cardPile); }
				if (ui.discardPile) { snap.discard = nodeList(ui.discardPile); }
				if (ui.ordering) { snap.ordering = nodeList(ui.ordering); }
				try { var g0 = historyState(game.me || {}); snap.gHist = { gLen: g0.gLen, gLast: g0.gLast }; } catch (e) { }
				try { snap.globals = snapshotGlobals(); } catch (e) { }
				return snap;
			}
			/* ---- 牌的"净化"：本体用 goto() 搬牌时会留 removing/destiny/延时器，
			   带着这些痕迹的牌会被 getCards("h") 跳过、get.position 认错位置，
			   表现就是"手里的牌是暗的、点不动"。fix() 会清掉 timeout/destiny/removing。 ---- */
			function prepCard(card) {
				try { if (card.fix) { card.fix(); } } catch (e) { }
				try {
					card.classList.remove('removing');
					card.classList.remove('drawinghidden');
					card.classList.remove('glow');
					card.classList.remove('glows');
					card.classList.remove('selected');
					card.classList.remove('target');
				} catch (e) { }
				try { card.style.transform = ''; } catch (e) { }
				try { delete card._transform; } catch (e) { }
				return card;
			}
			function scratchNode() {
				try { return ui.create.div(); } catch (e) { }
				try { return document.createElement("div"); } catch (e) { }
				return null;
			}
						function copyArr(a) { try { return Array.isArray(a) ? a.slice(0) : []; } catch (e) { return []; } }
			function restoreArr(target, snap) {
				try {
					if (!Array.isArray(target) || !Array.isArray(snap)) { return; }
					target.length = 0;
					for (var i = 0; i < snap.length; i++) { target.push(snap[i]); }
				} catch (e) { }
			}
			/* additionalSkills / disabledSkills / forbiddenSkills 都是"技能名 -> 数组或 true" */
			function copySkillMap(m) {
				var out = {};
				try {
					for (var k in m) {
						if (!Object.prototype.hasOwnProperty.call(m, k)) { continue; }
						var v = m[k];
						if (Array.isArray(v)) { out[k] = v.slice(0); }
						else if (v === true || typeof v === 'number' || typeof v === 'string') { out[k] = v; }
					}
				} catch (e) { }
				return out;
			}
			function restoreSkillMap(target, snap) {
				try {
					if (!target || !snap) { return; }
					for (var k in target) {
						if (!Object.prototype.hasOwnProperty.call(target, k)) { continue; }
						if (!Object.prototype.hasOwnProperty.call(snap, k)) { delete target[k]; }
					}
					for (var k2 in snap) {
						if (!Object.prototype.hasOwnProperty.call(snap, k2)) { continue; }
						target[k2] = Array.isArray(snap[k2]) ? snap[k2].slice(0) : snap[k2];
					}
				} catch (e) { }
			}
			function markKeys(p) {
				var out = [];
				try { for (var k in p.marks) { if (Object.prototype.hasOwnProperty.call(p.marks, k)) { out.push(k); } } } catch (e) { }
				return out;
			}
			/* 技能状态整体还原 ----
			   除了 skills/tempSkills，还必须处理"角色标记"：临时技能（例如谋陈宫·智迟的
			   sbzhichi_muteki）并不在 player.skills 里，只在 tempSkills + player.marks 里。
			   只删 tempSkills 不删标记的话，标记节点会留在 player.marks 上，
			   之后再 addTempSkill 时 markSkill 看到"已经标过了"就直接 return，
			   表现就是：回溯后无论怎么打他，标记都不再出现。 */
			function syncSkills(p, rec) {
				/* a) 移除快照里没有的技能（走本体方法，能顺带处理触发器与标记） */
				try {
					copyArr(p.skills).forEach(function (s) {
						if (rec.skills.indexOf(s) < 0) { try { p.removeSkill(s); } catch (e) { } }
					});
				} catch (e) { }
				/* b) 清掉快照里没有的标记（含临时技能留下的） */
				try {
					var want = rec.markList || [];
					markKeys(p).forEach(function (mn) {
						if (want.indexOf(mn) >= 0) { return; }
						try { p.unmarkSkill(mn); } catch (e) { }
						try { if (p.marks && p.marks[mn]) { delete p.marks[mn]; } } catch (e) { }
					});
				} catch (e) { }
				/* c) 补齐快照里有的技能（本体 addSkill 遇到 lib.skill 未注册会静默返回，所以再强对齐一次数组） */
				try {
					rec.skills.forEach(function (s) {
						try { if (!lib.skill[s]) { return; } } catch (e) { }
						try { if (p.skills.indexOf(s) < 0) { p.skills.push(s); } } catch (e) { }
						try { if (!p.hasSkill(s)) { p.addSkill(s); } } catch (e) { }
					});
				} catch (e) { }
				/* d) 隐藏 / 不可见 / 临时技能 / 额外技能 */
				restoreArr(p.hiddenSkills, rec.hidden);
				restoreArr(p.invisibleSkills, rec.invisible);
				restoreSkillMap(p.tempSkills, rec.tempSkills);
				restoreSkillMap(p.additionalSkills, rec.additional);
				/* e) 限定技/觉醒技"已用"、被禁用技能、跳过阶段 */
				restoreArr(p.awakenedSkills, rec.awakened);
				restoreArr(p.skipList, rec.skipList);
				restoreSkillMap(p.disabledSkills, rec.disabled);
				restoreSkillMap(p.forbiddenSkills, rec.forbidden);
				/* f) 快照里该有的标记补回来 */
				try {
					(rec.markList || []).forEach(function (mn) {
						try { if (!(p.marks && p.marks[mn])) { p.markSkill(mn, true); } } catch (e) { }
					});
				} catch (e) { }
				try { p.updateMarks(); } catch (e) { }
			}
			function copyVal(v) {
				if (v === null) { return null; }
				var tv = typeof v;
				if (tv === 'number' || tv === 'string' || tv === 'boolean') { return v; }
				if (Array.isArray(v)) { return v.slice(0); }
				if (tv === 'object' && Object.prototype.toString.call(v) === '[object Object]') { return shallow(v); }
				return undefined;
			}
			function syncMarks(p, m) {
				try {
					for (var k in m) {
						if (!Object.prototype.hasOwnProperty.call(m, k)) { continue; }
						var v = copyVal(m[k]);
						if (v !== undefined) { p.storage[k] = v; }
					}
					/* 记录之后新出现的"技能标记"要删掉（例如用了逆固后多出来的 counttrigger） */
					for (var k2 in p.storage) {
						if (!Object.prototype.hasOwnProperty.call(p.storage, k2)) { continue; }
						if (Object.prototype.hasOwnProperty.call(m, k2)) { continue; }
						if (lib.skill[k2]) { try { delete p.storage[k2]; } catch (e) { } }
					}
				} catch (e) { }
			}
			/* 每回合限一次等计数：本体读的是 player.getStat("skill")[技能id] */
			function syncStat(p, rec) {
				try {
					if (!p.stat) { return; }
					if (p.stat.length > rec.statLen) { p.stat.length = rec.statLen; }
					if (rec.statAll) {
						for (var i = 0; i < rec.statAll.length && i < p.stat.length; i++) {
							var s2 = rec.statAll[i], d2 = p.stat[i];
							if (!s2 || !d2) { continue; }
							d2.skill = shallow(s2.skill);
							d2.card = shallow(s2.card);
							d2.damage = s2.damage; d2.damaged = s2.damaged;
							d2.gain = s2.gain; d2.kill = s2.kill;
						}
					}
				} catch (e) { }
			}
			/* 铁索 / 翻面在本体里就是角色节点上的 class（isLinked / isTurnedOver 都只读 class），
			   而 player.link() / player.turnOver() 是"创建事件"，同步还原时不能用 */
			function setLinked(p, want) {
				try {
					var two = false;
					try { two = !!(get.is && get.is.linked2 && get.is.linked2(p)); } catch (e) { }
					var c1 = two ? 'linked2' : 'linked', c2 = two ? 'linked' : 'linked2';
					if (want) { p.classList.add(c1); p.classList.remove(c2); }
					else { p.classList.remove(c1); p.classList.remove(c2); }
				} catch (e) { }
			}
			function setTurned(p, want) {
				try { if (want) { p.classList.add('turnedover'); } else { p.classList.remove('turnedover'); } } catch (e) { }
			}
						/* 让本体重算"哪些牌/技能可用"——这一步是"还原后牌变暗、点不动"的解药。
			   本体把结果缓存在 _status.event._cardChoice/_targetChoice/_skillChoice 上，
			   换了手牌却不删缓存的话：牌拿不到 .selectable（被 #arena.selecting 的 CSS 变暗），
			   技能按钮也不会重建。本体自己的 game.gs() 就是"删三个缓存 + game.check()"。 */
			function refreshUsable(delay) {
				try {
					var ev = _status.event;
					for (var i = 0; i < 30 && ev; i++) {
						try { delete ev._cardChoice; } catch (e) { }
						try { delete ev._targetChoice; } catch (e) { }
						try { delete ev._skillChoice; } catch (e) { }
						ev = ev.parent;
					}
					try {
						if (ui.selected) {
							ui.selected.cards.length = 0;
							ui.selected.targets.length = 0;
							ui.selected.buttons.length = 0;
						}
					} catch (e) { }
					if (typeof game.check == "function") { game.check(_status.event); }
					if (delay !== false) { setTimeout(function () { try { game.check(_status.event); } catch (e) { } }, 300); }
				} catch (e) { }
			}

			function restore(snap) {
				if (!snap) return;
				HF.restoring = true;
				try {
					var players = allP();
					/* ===== A. 把场上所有看得到的牌先收进临时区 ===== */
					var revived = 0;
					var scratch = scratchNode();
					var seen = [];
					var containers = [];
					["cardPile", "discardPile", "ordering", "special"].forEach(function (k) { if (ui[k]) { containers.push(ui[k]); } });
					players.forEach(function (p) {
						try {
							["handcards1", "handcards2", "equips", "judges", "expansions"].forEach(function (k) {
								if (p.node && p.node[k]) { containers.push(p.node[k]); }
							});
						} catch (e) { }
					});
					containers.forEach(function (node) {
						var list = nodeList(node);
						for (var i = 0; i < list.length; i++) {
							var c = list[i];
							if (!c || seen.indexOf(c) >= 0) { continue; }
							seen.push(c);
							prepCard(c);
							try { scratch.appendChild(c); } catch (e) { }
						}
					});
					/* 兜底：全场景扫描所有 .card。判定区/处理区在某些 UI 下并不在常规容器里
					   （例如自己身上的闪电），只扫常规容器会漏掉，于是"回溯完闪电还在"。
					   先收集成数组再搬（getElementsByClassName 是实时集合，边搬边遍历会漏）。 */
					[ui.arena, ui.window].forEach(function (root) {
						if (!root || !root.getElementsByClassName) { return; }
						var list0 = [];
						try { var live = root.getElementsByClassName("card"); for (var q = 0; q < live.length; q++) { list0.push(live[q]); } } catch (e) { return; }
						for (var w = 0; w < list0.length; w++) {
							var c0 = list0[w];
							if (!c0 || seen.indexOf(c0) >= 0) { continue; }
							/* 只认真正的牌：牌有 name，且有内部 node.name 结构（菜单里同名的装饰元素没有） */
							if (!(typeof c0.name === "string" || (c0.node && c0.node.name))) { continue; }
							seen.push(c0);
							prepCard(c0);
							try { scratch.appendChild(c0); } catch (e) { }
						}
					});
					/* ===== B. 牌堆：按记录顺序 append（本体就是 appendChild 到堆尾，firstChild＝牌堆顶），
					       这样"排序"和"张数"都与记录那一刻完全一致 ===== */
					var pile = ui.cardPile;
					if (pile) { for (var i2 = 0; i2 < snap.pile.length; i2++) { try { pile.appendChild(snap.pile[i2]); } catch (e) { } } }
					/* ===== C. 弃牌堆 / 处理区 ===== */
					var disc = ui.discardPile || ui.ordering;
					if (disc) { for (var j2 = 0; j2 < snap.discard.length; j2++) { try { disc.appendChild(snap.discard[j2]); } catch (e) { } } }
					if (ui.ordering && ui.ordering !== disc && snap.ordering) {
						for (var j3 = 0; j3 < snap.ordering.length; j3++) { try { ui.ordering.appendChild(snap.ordering[j3]); } catch (e) { } }
					}
					/* ===== D. 每个角色 ===== */
					snap.players.forEach(function (rec) {
						var p = bySeat(rec.seat);
						if (!p) { return; }
						/* 快照时还活着、现在却阵亡 -> 用本体自带的 revive 复活（会解开 dead、
						   恢复 hp/装备区显示、重连 previous/next 座次、把角色挪回 game.players） */
						try {
							if (rec.alive !== false && p.isDead && p.isDead() && p.revive) {
								p.revive(rec.hp > 0 ? rec.hp : 1, false);
								revived++;
								console.log("[复盘工具] 已复活：" + (rec.name || "") + " " + p.hp + "/" + p.maxHp);
							}
						} catch (e) { console.error("复盘工具：复活失败", e); }
						var n = p.node || {};
						/* 手牌（按记录的左右手容器分别插回，倒序 insertBefore 到最前＝顺序不变） */
						try {
							if (n.handcards1 && rec.hand1) { for (var a = rec.hand1.length - 1; a >= 0; a--) { n.handcards1.insertBefore(rec.hand1[a], n.handcards1.firstChild); } }
							if (n.handcards2 && rec.hand2) { for (var b = rec.hand2.length - 1; b >= 0; b--) { n.handcards2.insertBefore(rec.hand2[b], n.handcards2.firstChild); } }
						} catch (e) { }
						/* 装备（本体 $equip 会按类型排序并清理痕迹） */
						try { if (rec.equip && rec.equip.length) { p.directequip(rec.equip.slice(0)); } } catch (e) { }
						/* 判定区 */
						try {
							if (n.judges && rec.judge) { for (var d = rec.judge.length - 1; d >= 0; d--) { n.judges.insertBefore(rec.judge[d], n.judges.firstChild); } }
						} catch (e) { }
						/* 武将牌上 / 移出游戏的牌 */
						try {
							if (n.expansions && rec.expand) { for (var x = rec.expand.length - 1; x >= 0; x--) { n.expansions.insertBefore(rec.expand[x], n.expansions.firstChild); } }
						} catch (e) { }
						/* 体力 / 上限 */
						try { if (p.maxHp !== rec.maxHp) { p.maxHp = rec.maxHp; } } catch (e) { }
						try { p.hp = rec.hp; } catch (e) { }
						/* 铁索 / 翻面（直接改 class） */
						setLinked(p, rec.linked);
						setTurned(p, rec.turned);
						/* 移出游戏：十常侍「休整」结束要能回来 */
						try {
							p.outCount = rec.outCount || 0;
							if (rec.outSkills && rec.outSkills.length) { p.outSkills = rec.outSkills.slice(0); }
							else { try { delete p.outSkills; } catch (e) { } }
							if (rec.out) { if (!p.classList.contains("out")) { p.classList.add("out"); } }
							else { p.classList.remove("out"); }
						} catch (e) { }
						/* 技能集合 / 标记 / 限一次计数 */
						syncSkills(p, rec);
						syncMarks(p, rec.marks);
						syncStat(p, rec);
						syncHistory(p, rec.hist);
						/* 刷新界面 */
						try { p.update(); } catch (e) { }
						try { ui.updatej(p); } catch (e) { }
						try { ui.updatem(p); } catch (e) { }
						try { if (p === game.me) { ui.updatehl(); } } catch (e) { }
					});
					/* ===== E. 快照之后才冒出来的牌（技能造牌等）一律进弃牌堆===== */
					if (scratch) {
						var left = nodeList(scratch);
						for (var k = 0; k < left.length; k++) {
							try { if (disc) { disc.appendChild(left[k]); } else { left[k].remove(); } } catch (e) { }
						}
					}
					/* ===== F. 牌堆张数显示 / 手牌排版 / 可用性重算 / 全局历史 ===== */
					syncGlobalHistory(snap.gHist);
					/* 挂在 _status 上的技能状态（十常侍休整等） */
					restoreGlobals(snap.globals);
					try { _status.cardPileNum = pile ? pile.childNodes.length : 0; } catch (e) { }
					try { if (game.updateRoundNumber) { game.updateRoundNumber(); } } catch (e) { }
					try { if (ui.cardPileNumber && pile) { ui.cardPileNumber.innerHTML = game.roundNumber + "轮 剩余牌: " + pile.childNodes.length; } } catch (e) { }
					try { ui.updatehl(); } catch (e) { }
					try { ui.updatej(game.me); } catch (e) { }
					/* 最关键的一步：重算可用性，否则牌是暗的、技能按钮也是旧的 */
					refreshUsable();
					try { refreshPileBar(); } catch (e) { }
					/* 明牌开关是"常驻配置"，回滚技能表之后要重新挂上 */
					try { applyHandTag(); } catch (e) { }
					/* ===== G. 重新开始统计 ===== */
					HF.start = snap;
					HF.stat = newStat();
					HF.seqId = 0;
					try {
						console.log("[复盘工具] 已回到起点：" + (revived ? ("复活 " + revived + " 人；") : "") + "牌堆 " + (pile ? pile.childNodes.length : "?") + " 张 / 弃牌堆 " + (disc ? disc.childNodes.length : "?") + " 张" +
							snap.players.map(function (r) {
								var p2 = bySeat(r.seat);
								var sk = (p2 && p2.getStat) ? JSON.stringify(p2.getStat("skill")) : "?";
								var ct = (p2 && p2.storage && p2.storage.counttrigger) ? JSON.stringify(p2.storage.counttrigger) : "{}";
								var hnow = (p2 && p2.getCards) ? p2.getCards("h").length : -1;
								var hwant = ((r.hand1 || []).length + (r.hand2 || []).length);
								return " | " + (r.name || "?") + " 手牌" + hnow + "/" + hwant + " 技能次数" + sk + " 限一次表" + ct;
							}).join(""));
					} catch (e) { }
				} catch (e) { console.error("复盘工具：还原出错", e); }
				HF.restoring = false;
			}
			/* ============ 全局 _status 上的技能状态 ============
			   有些技能把状态挂在 _status 而不是 player.storage，例如十常侍的「休整」：
			   _status.mbmowang_return[player.playerid] = 1（character/mobile.js:4495）。
			   这种键没法穷举，所以自动扫一遍在场技能的源码，把引用到的 _status.xxx 收集起来，
			   连同快照一起存、一起还原。 */
			var STATUS_SKIP = {
				event: 1, globalHistory: 1, over: 1, paused: 1, auto: 1, video: 1, connectMode: 1, online: 1,
				currentPhase: 1, cardPileNum: 1, pileTop: 1, discarded: 1, dying: 1, roundStart: 1, characterlist: 1,
				prehidden_skills: 1, immediateReply: 1, renku: 1, noclearcountdown: 1, multitarget: 1, imchoosing: 1,
				noupdatec: 1, createControl: 1, skipped: 1, mode: 1, coin: 1, tempnowuxie: 1, brawl: 1
			};
			var _statusKeys = [], _scannedSkills = {};
			function scanObjStatus(obj, depth) {
				if (!obj || depth > 2) { return; }
				try {
					for (var k in obj) {
						if (!Object.prototype.hasOwnProperty.call(obj, k)) { continue; }
						var v = obj[k], ty = typeof v;
						if (ty === 'function' || ty === 'string') {
							var s = String(v);
							var re = /_status\.([A-Za-z_$][0-9A-Za-z_$]*)/g, m;
							while ((m = re.exec(s))) { if (!STATUS_SKIP[m[1]] && _statusKeys.indexOf(m[1]) < 0) { _statusKeys.push(m[1]); } }
						}
						else if (v && ty === 'object' && !Array.isArray(v) && depth < 2) { scanObjStatus(v, depth + 1); }
					}
				} catch (e) { }
			}
			function ensureStatusScan() {
				try {
					var pool = [];
					allP().forEach(function (p) {
						try { pool = pool.concat(p.getSkills("invisible")); } catch (e) { }
						try { var ch = lib.character[p.name]; if (ch && ch[3]) { pool = pool.concat(ch[3]); } } catch (e) { }
					});
					try { pool = pool.concat(lib.skill.global || []); } catch (e) { }
					try { pool = pool.concat(Object.keys(game.skill || {})); } catch (e) { }
					for (var i = 0; i < pool.length; i++) {
						var nm = pool[i];
						if (!nm || _scannedSkills[nm]) { continue; }
						_scannedSkills[nm] = 1;
						scanObjStatus(lib.skill[nm], 0);
					}
				} catch (e) { }
			}
			function snapshotGlobals() {
				ensureStatusScan();
				var out = {};
				try {
					_statusKeys.forEach(function (k) {
						var v = _status[k], tv = typeof v;
						if (v === undefined) { return; }
						if (v === null || tv === 'number' || tv === 'string' || tv === 'boolean') { out[k] = v; }
						else if (Array.isArray(v)) { out[k] = v.slice(0); }
						else if (tv === 'object' && Object.prototype.toString.call(v) === '[object Object]') { out[k] = shallow(v); }
					});
				} catch (e) { }
				return out;
			}
			function restoreGlobals(g) {
				try {
					if (!g) { return; }
					for (var k in g) {
						if (!Object.prototype.hasOwnProperty.call(g, k)) { continue; }
						var v = g[k];
						_status[k] = Array.isArray(v) ? v.slice(0) : (v && typeof v === 'object' ? shallow(v) : v);
					}
					/* 快照里没有、现在冒出来的要清掉 */
					_statusKeys.forEach(function (k2) {
						if (Object.prototype.hasOwnProperty.call(g, k2)) { return; }
						var cur = _status[k2];
						if (cur === undefined) { return; }
						if (Array.isArray(cur)) { cur.length = 0; }
						else if (cur && typeof cur === 'object' && Object.prototype.toString.call(cur) === '[object Object]') {
							for (var kk in cur) { if (Object.prototype.hasOwnProperty.call(cur, kk)) { delete cur[kk]; } }
						}
						else { try { delete _status[k2]; } catch (e) { } }
					});
				} catch (e) { }
			}

			/* ============ 敌我判定 ============ */
			function teamClass(id) {
				if (!id) { return null; }
				if (id === 'zhu' || id === 'zhong' || id === 'lord' || id === 'zhu2') { return 'lord'; }
				if (id === 'fan' || id === 'nong' || id === 'rebel' || id === 'peasant') { return 'rebel'; }
				if (id === 'nei' || id === 'spy') { return null; }
				return id;
			}
			function sideOf(p) {   /* 'self' | 'ally' | 'enemy' | 'unknown' */
				if (!p) { return 'unknown'; }
				if (p === game.me) { return 'self'; }
				try { if (game.me && game.me.side && p.side) { return p.side === game.me.side ? "ally" : "enemy"; } } catch (e) { }
				try {
					var ca = teamClass(game.me && game.me.identity), cb = teamClass(p.identity);
					if (ca && cb) { return ca === cb ? "ally" : "enemy"; }
				} catch (e) { }
				try {
					var att = get.attitude(game.me, p);
					if (att > 0) { return "ally"; }
					if (att < 0) { return "enemy"; }
				} catch (e) { }
				return "unknown";
			}
			var SIDE_TEXT = { self: '自己', ally: '友方', enemy: '敌方', unknown: '身份未明' };
			/* 敌我语义色 → iOS system colors（label / green / red / yellow） */
			var SIDE_COLOR = { self: 'rgba(235,235,245,.92)', ally: '#30D158', enemy: '#FF453A', unknown: '#FFD60A' };
			function sideSpan(p) {
				var s = sideOf(p);
				return '<span style="color:' + SIDE_COLOR[s] + '">' + PN(p) + '</span>';
			}

			/* 把「谁挨了多少、谁死了」按敌我拆开（记录时算一次，存进记录） */
			function sideDamage(st) {
				var d = {
					enemyDmg: 0, allyDmg: 0, unknownDmg: 0, selfTaken: 0, friendlyTaken: 0,
					selfHpDelta: 0, selfHp0: 0, selfHpNow: 0, selfMax: 0,
					enemyHp0: 0, enemyHpNow: 0, enemyMax: 0, enemyCount: 0, allyMax: 0,
					acts: 0, gain: st.gain || 0, lose: st.lose || 0, kills: st.kill || 0, killList: (st.killList || []).slice(0)
				};
				try {
					allP().forEach(function (p) {
						var nm = PN(p), got = st.tgt[nm] ? st.tgt[nm].n : 0;
						var s = sideOf(p);
						if (got) {
							if (s === "enemy") { d.enemyDmg += got; }
							else if (s === "ally") { d.allyDmg += got; }
							else if (s === "self") { d.selfTaken += got; }
							else { d.unknownDmg += got; }
						}
						var a = st.hp0[SEAT(p)], b = st.hpNow[SEAT(p)];
						if (a === undefined) { a = p.hp; }
						if (b === undefined) { b = p.hp; }
						if (s === "enemy") {
							d.enemyHp0 += Math.max(0, a); d.enemyHpNow += Math.max(0, b); d.enemyMax += (p.maxHp || 0);
							if (a > 0) { d.enemyCount++; }
						}
						else if (s === "ally") { d.allyMax += (p.maxHp || 0); d.friendlyTaken += Math.max(0, a - b); }
						else if (s === "self") {
							d.selfHp0 += a; d.selfHpNow += b; d.selfMax += (p.maxHp || 0);
							d.selfHpDelta += (b - a);
							d.friendlyTaken += Math.max(0, a - b);
						}
					});
					d.acts = (st.seq || []).length;
				} catch (e) { }
				return d;
			}

			/* ================= 3. 统计 ================= */

			function newStat() {
				var st = {
					t0: Date.now(), total: 0, card: 0, skill: 0, nigu: 0, kill: 0, killList: [],
					tgt: {}, src: {}, nat: {},
					draw: 0, gain: 0, lose: 0, discard: 0,
					hp0: {}, hpNow: {}, seq: []
				};
				allP().forEach(function (p) { st.hp0[SEAT(p)] = p.hp; st.hpNow[SEAT(p)] = p.hp; });
				return st;
			}
			HF.stat = newStat();

			function skillAt(evt) {
				/* 沿事件链往上找最近的"真技能"事件（技能事件名＝技能id） */
				try {
					var e = evt && evt.parent;
					for (var i = 0; i < 40 && e; i++) {
						if (e.name && lib.skill[e.name] && e.name.charAt(0) !== '_') return e.name;
						e = e.parent;
					}
				} catch (err) { }
				return null;
			}
			/* 动作条目：i = 序号（标记类条目 i 为 null，不占号），tg = 本次目标名
			   hits = [{name,n}] 谁挨了多少，tail = 附加标记（※阵亡 等）
			   渲染 = 「N. 牌名 目标」+「 -N」（红）… +「 ※阵亡」…，一律单空格分隔 */
			function seqPush(text, noNum, tg) {
				var st = HF.stat;
				if (!st) return null;
				var item = { i: noNum ? null : (++HF.seqId), text: text, tg: tg || "", tail: "", time: Date.now(), hits: [] };
				st.seq.push(item);
				if (st.seq.length > 400) { st.seq.shift(); }
				return item;
			}
			/* 把标记挂到上一条动作后面（4 秒内算同一次操作）；挂不上返回 false */
			/* 阵亡的人是不是"上一条动作的目标" */
			function isSameTarget(who) {
				try {
					var st = HF.stat;
					if (!st || !st.seq.length) { return false; }
					var last = st.seq[st.seq.length - 1];
					return !!(last && last.tg && last.tg.indexOf(rel(who)) >= 0);
				} catch (e) { }
				return false;
			}
			function seqAttach(marker, windowMs) {
				var st = HF.stat;
				if (!st || !st.seq.length) { return false; }
				var last = st.seq[st.seq.length - 1];
				if (last.i === null) { return false; }
					if (Date.now() - last.time < (windowMs || 4000)) { last.tail = (last.tail ? last.tail + " " : "") + marker; return true; }
				return false;
			}
			function targetText(tg) {
				if (!tg) return '';
				if (Array.isArray(tg)) {
					if (!tg.length) return '';
					if (tg.length === 1) return rel(tg[0]);
					return tg.map(rel).join('、');
				}
				return rel(tg);
			}
			/* 统一渲染：动作 + 伤害 + 附加标记（html=true 时伤害带红色） */
			function seqLine(e, html) {
				var s = (e.i === null ? "" : e.i + ". ") + e.text;
				var hits = e.hits || [];
				for (var i = 0; i < hits.length; i++) {
					var h = hits[i];
					var who = (h.name && h.name !== e.tg) ? h.name : "";
					s += " " + who + (html ? dmgTxt(h.n) : ("-" + h.n));
				}
				if (e.tail) { s += " " + e.tail; }
				return s;
			}
			function seqText(e) { return seqLine(e, false); }
			function seqHTML(e) { return seqLine(e, true); }
			/* 伤害合并到上一条动作（多段伤害累加）；挂不上返回 false */
			function markSeqDmg(n, name) {
				var st = HF.stat;
				if (!st || !st.seq.length) return false;
				var last = st.seq[st.seq.length - 1];
				if (last.i === null) { return false; }
				if (Date.now() - last.time < 4000) {
					var hits = last.hits || (last.hits = []);
					for (var i = 0; i < hits.length; i++) { if (hits[i].name === name) { hits[i].n += n; return true; } }
					hits.push({ name: name, n: n });
					return true;
				}
				return false;
			}

			/* 钩子用：只有"开始统计"之后才记；还原过程中不记 */
			function canRec() { return HF.stat && !HF.restoring && !_status.video; }

						/* 连锁传导：沿事件链找 _lianhuan（铁索连环的传导技能，game.js:34741） */
			function isChainDamage(evt) {
				try {
					var e = evt && evt.parent;
					for (var i = 0; i < 12 && e; i++) {
						if (e.name === '_lianhuan') { return true; }
						e = e.parent;
					}
				} catch (err) { }
				return false;
			}
			/* 伤害有两条钩子（source:damageSource 与 player:damageAfter），同一事件只记一次 */
			function onDamage(evt) {
				if (!canRec()) return;
				try {
					if (evt._hfSeen) { return; }
					evt._hfSeen = true;
					var st = HF.stat, n = evt.num || 0, p = evt.player, srcP = evt.source;
					if (!p || !n) { return; }
					var isCard = !!evt.card;
					var chain = isChainDamage(evt);
					var srcName;
					if (isCard) { srcName = cardName(evt.card); }
					else { srcName = T(skillAt(evt)) || (srcP ? (PN(srcP) + "·伤害") : "来源不明"); }
					if (chain) { srcName += "［连环传导］"; }
					st.total += n;
					if (isCard) { st.card += n; } else { st.skill += n; }
					var tk = PN(p);
					if (!st.tgt[tk]) { st.tgt[tk] = { n: 0, card: 0, skill: 0, nat: {}, chain: 0 }; }
					st.tgt[tk].n += n;
					if (chain) { st.tgt[tk].chain = (st.tgt[tk].chain || 0) + n; }
					if (isCard) { st.tgt[tk].card += n; } else { st.tgt[tk].skill += n; }
					var nat = evt.nature || "normal";
					st.tgt[tk].nat[nat] = (st.tgt[tk].nat[nat] || 0) + n;
					st.nat[nat] = (st.nat[nat] || 0) + n;
					st.src[srcName] = (st.src[srcName] || 0) + n;
					st.hpNow[SEAT(p)] = p.hp;
					if (!markSeqDmg(n, rel(p))) {
						seqPush("※" + PN(p) + " " + dmgTxt(n) + (nat !== "normal" ? "（" + T(nat) + "）" : "") + " " + srcName, true);
					}
				} catch (e) { console.error("复盘工具：伤害记录出错", e); }
			}
			function onUseCard(evt) {
				if (!canRec()) return;
				try {
					var p = evt.player;
					var name = cardName(evt.card || (evt.cards && evt.cards[0]));
					var tg = targetText(evt.targets && evt.targets.length ? evt.targets : null);
					seqPush(T(name) + (tg ? ' ' + tg : ''), false, tg);
				} catch (e) { }
			}
			function onUseSkill(evt) {
				if (!canRec()) return;
				try {
					var sk = evt.skill || (evt.parent && evt.parent.skill);
					if (!sk || sk.charAt(0) === '_') return;
					var tg = targetText(evt.targets && evt.targets.length ? evt.targets : null);
					seqPush('【' + T(sk) + '】' + (tg ? ' ' + tg : ''), false, tg);
				} catch (e) { }
			}
			function onGain(evt) {
				if (!canRec()) return;
				try {
					var st = HF.stat, p = evt.player;
					if (!p) return;
					var n = (evt.cards || []).length;
					if (!n) return;
					st.gain += n;
					if (isMine(p)) { /* 自己的过牌才算进"过牌"主数据 */ }
				} catch (e) { }
			}
			function onLose(evt) {
				if (!canRec()) return;
				try {
					var st = HF.stat, p = evt.player;
					if (!p) return;
					var n = ((evt.hs || []).length + (evt.es || []).length + (evt.js || []).length);
					if (!n) { n = (evt.cards || []).length; }
					if (!n) return;
					st.lose += n;
				} catch (e) { }
			}
			function onDiscard(evt) {
				if (!canRec()) return;
				try {
					var st = HF.stat;
					var n = (evt.cards || []).length;
					if (n) st.discard += n;
				} catch (e) { }
			}
			function onHp(evt) {
				if (!canRec()) return;
				try {
					var st = HF.stat, p = evt.player;
					if (!p) return;
					st.hpNow[SEAT(p)] = p.hp;
				} catch (e) { }
			}

			/* ================= 4. 注册统计钩子 ================= */
			lib.skill._hf_dmg = {
				trigger: { source: 'damageSource' },
				forced: true, silent: true, popup: false, charlotte: true,
				content: function () { window.hfTool.hook('damage', trigger, player, 'source'); }
			};
			lib.skill._hf_use = {
				trigger: { player: 'useCard' },
				forced: true, silent: true, popup: false, charlotte: true,
				content: function () { window.hfTool.hook('card', trigger, player, 'player'); }
			};
			/* 受害者视角的伤害钩子：铁索连环传导的伤害也会走到这里，
			   与 source 钩子用事件对象去重，保证"每点伤害都有来源且只记一次" */
			lib.skill._hf_dmgp = {
				trigger: { player: 'damageAfter' },
				forced: true, silent: true, popup: false, charlotte: true,
				content: function () { window.hfTool.hook('damage', trigger, player, 'player'); }
			};
			/* 击杀 */
			lib.skill._hf_die = {
				trigger: { global: 'dieAfter' },
				forced: true, silent: true, popup: false, charlotte: true,
				content: function () { window.hfTool.hook('die', trigger, player, 'global'); }
			};
			lib.skill._hf_skill = {
				trigger: { player: 'useSkillAfter' },
				forced: true, silent: true, popup: false, charlotte: true,
				content: function () { window.hfTool.hook('skill', trigger, player, 'player'); }
			};
			lib.skill._hf_gain = {
				trigger: { player: 'gainAfter' },
				forced: true, silent: true, popup: false, charlotte: true,
				content: function () { window.hfTool.hook('gain', trigger, player, 'player'); }
			};
			lib.skill._hf_lose = {
				trigger: { player: 'loseAfter' },
				forced: true, silent: true, popup: false, charlotte: true,
				content: function () { window.hfTool.hook('lose', trigger, player, 'player'); }
			};
			lib.skill._hf_discard = {
				trigger: { player: 'discardAfter' },
				forced: true, silent: true, popup: false, charlotte: true,
				content: function () { window.hfTool.hook('discard', trigger, player, 'player'); }
			};
			lib.skill._hf_hp = {
				trigger: { player: 'changeHp' },
				forced: true, silent: true, popup: false, charlotte: true,
				content: function () { window.hfTool.hook('hp', trigger, player, 'player'); }
			};
			function regHooks() {
				['_hf_dmg', '_hf_dmgp', '_hf_die', '_hf_use', '_hf_skill', '_hf_gain', '_hf_lose', '_hf_discard', '_hf_hp'].forEach(function (s) {
					try { game.addGlobalSkill(s); } catch (e) { }
				});
			}
			regHooks();

			/* 逆固加成：戮连/逆固每消耗 1 个标记＝1 点增伤，这里顺手统计 */
			try {
				var _rm = lib.element.player.removeMark;
				if (_rm && !_rm._hfWrapped) {
					lib.element.player.removeMark = function (name, num, log) {
						try {
							if (name === 'sunchen_nigu_add' && HF.stat && !HF.restoring) {
								HF.stat.nigu += (num || 1);
								if (HF.stat.src) { HF.stat.src['逆固加成'] = (HF.stat.src['逆固加成'] || 0) + (num || 1); }
							}
						} catch (e) { }
						return _rm.apply(this, arguments);
					};
					lib.element.player.removeMark._hfWrapped = true;
				}
			} catch (e) { }

			/* 每局开始重新注册一次，并重置界面状态 */
			lib.skill._hf_start = {
				trigger: { global: 'gameStart' },
				forced: true, silent: true, popup: false, charlotte: true,
				content: function () { window.hfTool.hook('start'); }
			};
			game.addGlobalSkill('_hf_start');

			/* ============ 拆顺明牌 ============
			   本体在"选对方的牌"时，只有 event.visible / 目标被自己控制 /
			   player.hasSkillTag('viewHandcard', null, target, true) 三者之一成立才按真实牌面列牌，
			   否则走 event.dialog.add([hs,'blank'])（牌背），而且顺序还被 hs.randomSort() 打乱
			   ——所以回溯后根本没法牵到同一张牌。
			   给 game.me 挂一个只有 ai.viewHandcard 的隐技能，就能让它按真实牌面列出来。 */
			var HAND_TAG = '_hf_viewhand';
			lib.skill[HAND_TAG] = {
			charlotte: true, silent: true, forced: true, popup: false, temp: true,
			ai: {
				viewHandcard: true,
				skillTagFilter: function () {
					try { return !!(window.hfTool && window.hfTool.cfg && window.hfTool.cfg.showHand); } catch (e) { return false; }
				}
			}
			};
			function applyHandTag() {
				try {
					var me = game.me;
					if (!me || !me.addSkill) { return; }
					var want = !!(HF.cfg && HF.cfg.showHand);
					if (want) { if (!me.hasSkill(HAND_TAG)) { me.addSkill(HAND_TAG); } }
					else if (me.hasSkill(HAND_TAG)) { me.removeSkill(HAND_TAG); }
				} catch (e) { }
			}

			/* ============ 自动快照 + 记录前询问：进入出牌阶段时 ============
			   注意：引擎里阶段触发的名字是 phaseUseBegin / phaseUseEnd / phaseDiscardBegin …，
			   没有 phaseUse 这个名字  */
			lib.skill._hf_turn = {
			trigger: { global: 'phaseUseBegin' },
			forced: true, silent: true, popup: false, charlotte: true,
			content: function () { window.hfTool.hook('auto', trigger, player, 'global'); }
			};
			game.addGlobalSkill('_hf_turn');
			/* 出牌阶段结束：用来把界面按钮收起来 */
			lib.skill._hf_turnend = {
			trigger: { global: 'phaseUseEnd' },
			forced: true, silent: true, popup: false, charlotte: true,
			content: function () { window.hfTool.hook('useend', trigger, player, 'global'); }
			};
			game.addGlobalSkill('_hf_turnend');
			/* 保险：确保它们真的在 global 表里（不在的话 global 触发不会派发） */
			try {
				["_hf_turn", "_hf_turnend"].forEach(function (n) {
					if (lib.skill.global && !lib.skill.global.contains(n)) { lib.skill.global.push(n); }
				});
			} catch (e) { }

						/* ===== 诊断：钩子调用环形缓冲 + 报告 ===== */
			HF.hookLog = HF.hookLog || [];
			HF.askLog = HF.askLog || [];
			HF.log = function (s) {
				try {
					HF.askLog.push(new Date().toTimeString().slice(0, 8) + " " + s);
					if (HF.askLog.length > 80) { HF.askLog.shift(); }
					console.log("[复盘工具] " + s);
				} catch (e) { }
			};
			/* 一次性诊断报告" */
			HF.diagReport = function () {
				var L = [], P = function (k, v) { L.push(k + ": " + v); };
				L.push("===== 复盘工具诊断 =====");
				try { P("时间", new Date().toLocaleString()); } catch (e) { }
				try { P("配置", JSON.stringify(HF.cfg)); } catch (e) { }
				try { P("localStorage.hf_cfg", String(localStorage.getItem("hf_cfg"))); } catch (e) { }
				try {
					var sk = lib.skill._hf_turn;
					P("_hf_turn 技能", sk ? ("有, trigger=" + JSON.stringify(sk.trigger)) : "缺失");
					P("_hf_turn 在 global 表", (lib.skill.global || []).indexOf("_hf_turn") >= 0);
					var tg = (sk && sk.trigger) || {};
					P("触发事件名", String(tg.global || tg.player || tg.source || "?"));
					P("触发名是否合法", String(tg.global) === "phaseUseBegin" ? "是（phaseUseBegin）" : "否！请检查");
					P("_hf_discardask 技能", lib.skill._hf_discardask ? "有（本轮已改为按钮，不该再有）" : "无（正确）");
				} catch (e) { }
				try { P("window.hfTool", window.hfTool ? ("ok, hook=" + typeof window.hfTool.hook) : "缺失"); } catch (e) { }
				try { var ly = layer(); P("浮层容器", ly === document.documentElement ? "documentElement" : (ly && ly.tagName)); } catch (e) { }
				try { P("game.me", game.me ? PN(game.me) : "无"); } catch (e) { }
				try { P("_status.event", _status.event ? _status.event.name : "无"); } catch (e) { }
				try { P("_status.phase", _status.phase); } catch (e) { }
				try { P("_status.over", _status.over); } catch (e) { }
				try { P("HF.restoring", HF.restoring); } catch (e) { }
				try { P("面板/弹窗", "panel=" + (HF.panel ? "有" : "无") + " askBox=" + (HF.askBox ? "有" : "无") + " overAsk=" + (HF.overAsk ? "有" : "无")); } catch (e) { }
				try { P("起点", "手动=" + (HF.start ? "有" : "无") + " 自动快照=" + (HF.autoStart ? "有" : "无")); } catch (e) { }
				L.push("----- 最近钩子调用（新→旧，最多 40 条）-----");
				var hl = (HF.hookLog || []).slice(-40).reverse();
				if (!hl.length) { L.push("（一条都没有！说明引擎根本没触发我们的钩子）"); }
				hl.forEach(function (e) { L.push("[" + e.k + "/" + e.r + "] " + e.e + " 角色=" + e.p + " 是我=" + e.me + " " + e.at); });
				L.push("----- 「记录前询问」日志 -----");
				var al = (HF.askLog || []).slice(-30);
				if (!al.length) { L.push("（空）"); }
				al.forEach(function (s) { L.push(s); });
				return L.join("\n");
			};
			/* 复制并显示一段文本（诊断/导出用） */
			HF.copyReport = function (title, txt, silent) {
				var ok = false;
				try {
					var ta = document.createElement("textarea");
					ta.value = txt;
					ta.style.position = "fixed"; ta.style.left = "-9999px";
					document.body.appendChild(ta);
					ta.select();
					ok = document.execCommand("copy");
					ta.remove();
				} catch (e) { }
				try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(txt); ok = true; } } catch (e) { }
				if (silent && ok) { toast("诊断信息已复制到剪贴板"); return ok; }   /* 静默复制：不弹窗打扰 */
				try {
					buildAsk(title, (ok ? "（已复制到剪贴板；若粘不出来就手动全选下面文字）" : "（复制失败，请手动全选下面文字）") + "<br><br>" + String(txt).replace(/</g, "&lt;").replace(/\n/g, "<br>"), [["知道了", function () { }]]);
				} catch (e) { }
				return ok;
			};
						/* 兼容壳 */
			HF.updateActions = function () {
				try {
					if (!HF.slots) { return; }
					HF.slots.forEach(function (s) {
						var ok = true;
						try { ok = !!s.act.need(); } catch (e) { }
						s.slot.style.display = ok ? "block" : "none";
					});
				} catch (e) { }
			};
			/* 通用弹窗 */
			function buildAsk(title, text, rows) {
				try { if (HF.askBox) { HF.askBox.remove(); HF.askBox = null; } } catch (e) { }
				var box = el("div", "hf-ask", layer());
				HF.askBox = box;
				box.innerHTML = `<div class="hf-sec"` + S.sec + `>` + title + `</div>` + `<div` + S.kv + `>` + text + `</div>`;
				var row = el("div", "hf-askrow", box);
				var close = function () { try { box.remove(); } catch (e) { } HF.askBox = null; };
				rows.forEach(function (r) {
					pbtn(row, r[0], function () { close(); try { r[1](); } catch (e) { console.error("复盘工具：弹窗回调出错", e); } });
				});
				return close;
			}
			/* 记录起点：面板按钮与弹窗都走这里 */
			HF.recordStart = function () {
				try {
					HF.start = snapshot();
					HF.stat = newStat();
					HF.seqId = 0;
					toast(`已开始记录（牌堆 ` + HF.start.pile.length + ` 张 / ` + HF.start.players.length + ` 人），统计已重置`);
					/* （已按用户要求移除：以前点【记录】会生成诊断信息并静默复制到剪贴板，现在不再做） */
					if (HF.cfg.autoClose && HF.open) { HF.toggle(false); } else if (HF.open) { HF.render(); }
				} catch (e) { console.error("复盘工具：记录起点失败", e); }
			};
			/* 这份快照里"自己的手牌"是不是真的攥着牌。
			   启动时（arenaReady）那一份是空的 —— 那时候还没发牌进手牌容器，
			   拿它当起点「重来」就会把牌全清掉。 */
			function snapHasCards(s) {
				try {
					var me = null;
					((s && s.players) || []).forEach(function (r) { if (r.seat === SEAT(game.me)) { me = r; } });
					return !!(me && (((me.hand1 || []).length) + ((me.hand2 || []).length)));
				} catch (e) { return false; }
			}
			/* 「可用的起点」：手动起点永远认；没有手动起点时，必须"自动快照开着 + 那份快照真有牌"。
			   没有可用起点就一律提示、绝不 restore。 */
			HF.usableStart = function () {
				try {
					if (HF.start) { return HF.start; }
					if (!HF.cfg.autoSnap) { return null; }
					if (!HF.autoStart || !snapHasCards(HF.autoStart)) { return null; }
					return HF.autoStart;
				} catch (e) { return null; }
			};
			/* 没有可用起点时统一说一句（重来 / 保存并回到起点 都走这里） */
			HF.noStartTip = function () {
				var msg = '请先记录起点或开启自动快照功能（现在没有可用的起点，「重来」会把牌清空）';
				try { toast(msg); } catch (e) { }
				try { hfToast(msg); } catch (e) { }   /* 自带的气泡：不用翻战报也能看见 */
			};
			/* 回到起点：手动起点优先，否则自动快照 */
			HF.backToStart = function () {
				try {
					var snap = HF.usableStart();
					if (!snap) { HF.noStartTip(); return false; }
					restore(snap);
					toast(`已回到` + (HF.start ? `起点` : `自动快照`) + `，统计已重置`);
					if (HF.open) { if (HF.cfg.autoClose) { HF.toggle(false); } else { HF.render(); } }
					return true;
				} catch (e) { console.error("复盘工具：回到起点失败", e); return false; }
			};
			/* 自己回合进入出牌阶段：自动快照 +（可选）问要不要记录起点 */
						/* 进入自己的出牌阶段：显示界面按钮（记录/重来/结束） */
			HF.onTurnStart = function (trigger) {
				try {
					if (!trigger || !game.me || trigger.player !== game.me) { return; }
					HF.autoSnapshot(trigger);   /* 开了自动快照顺手留一份 */
					HF.myUse = true;
					HF.log("进入出牌阶段：显示界面按钮");
					HF.updateActions();
				} catch (e) { console.error("复盘工具：出牌阶段处理出错", e); }
			};
			/* 出牌阶段结束：收起按钮 */
			HF.onUsePhaseEnd = function (trigger) {
				try {
					if (!game.me || (trigger && trigger.player && trigger.player !== game.me)) { return; }
					HF.myUse = false;
					HF.updateActions();
				} catch (e) { }
			};
HF.autoSnapshot = function (trigger) {
				try {
					if (!HF.cfg.autoSnap) { return; }
					var who = trigger && trigger.player;
					if (!who || who !== game.me) { return; }
					var snap2 = snapshot();
					/* 防呆：新快照里自己手牌为空（摸牌动画没就位等异常时机）就不覆盖上一个好快照 */
					var me = null, prevMe = null;
					try { snap2.players.forEach(function (r) { if (r.seat === SEAT(game.me)) { me = r; } }); } catch (e) { }
					if (HF.autoStart) { try { HF.autoStart.players.forEach(function (r) { if (r.seat === SEAT(game.me)) { prevMe = r; } }); } catch (e) { } }
					var empty = !me || !(((me.hand1 || []).length) + ((me.hand2 || []).length));
					var prevOk = prevMe && (((prevMe.hand1 || []).length) + ((prevMe.hand2 || []).length)) > 0;
					if (empty && prevOk) { return; }
					HF.autoStart = snap2;
					HF.autoTime = nowText();
					refreshPileBar();
				} catch (e) { }
			};
			/* ---- 供技能 content 调用的全局入口 ----
			   注意：无名杀的技能 content/filter 会被 new Function 重建（game.js:12075），
			   里面的闭包变量全部失效，只能用全局 window + 注入的参数（trigger/player…）。
			   所以钩子只写一行，真正逻辑挂在 window.hfTool 上，并且全程 try/catch */
			HF.onDie = function (evt) {
				try {
					if (!canRec() || !evt || !evt.player) { return; }
					var st = HF.stat, who = evt.player;
					if (!st || !st.killList) { return; }
					if (st.killList.indexOf(PN(who)) >= 0) { return; }   /* 同一个人只算一次 */
					st.kill++;
					st.killList.push(PN(who));
					var deadTxt = "※阵亡" + (isSameTarget(who) ? "" : " " + rel(who));
					if (!seqAttach(deadTxt)) {
						seqPush(deadTxt, true);
					}
				} catch (e) { }
			};
			HF.onDamage = onDamage;
			HF.onUseCard = onUseCard;
			HF.onUseSkill = onUseSkill;
			HF.onGain = onGain;
			HF.onLose = onLose;
			HF.onDiscard = onDiscard;
			HF.onHp = onHp;
			HF.hook = function (kind, trigger, player, role) {
				try {
					try {
						HF.hookLog.push({ k: kind, r: role, e: (trigger && trigger.name) || "?", p: (player && PN(player)) || "?", me: player === game.me, at: new Date().toTimeString().slice(0, 8) });
						if (HF.hookLog.length > 200) { HF.hookLog.shift(); }
					} catch (e0) { }
					if (kind === 'start') { HF.startGame(); return; }
					if (kind === 'auto') { HF.onTurnStart(trigger); return; }
					if (kind === 'die') { HF.onDie(trigger); return; }
					if (kind === 'useend') { HF.onUsePhaseEnd(trigger); return; }
					if (!trigger) { return; }
					if (role === 'source' && trigger.source !== player) { return; }
					if (role === 'player' && trigger.player !== player) { return; }
					var map = {
						damage: HF.onDamage, card: HF.onUseCard, skill: HF.onUseSkill,
						gain: HF.onGain, lose: HF.onLose, discard: HF.onDiscard, hp: HF.onHp
					};
					var f = map[kind];
					if (f) { f(trigger); }
				} catch (e) { /* 工具出错绝不打断游戏 */ }
			};

			/* ============ 结算前询问 ============ */
			function installOverHook() {
				try {
					var orig = game.over;
					if (!orig || orig._hfWrapped) { return; }
					game.over = function () {
						var args = Array.prototype.slice.call(arguments);
						try {
							if (HF.cfg.askOver && !HF._overAsking && !_status.over) {
								var snap = HF.usableStart();   /* 没有可用起点就不问回溯，直接正常结算 */
								if (snap) {
									HF._overAsking = true;
									HF.askOver(snap, function (doRestore, alsoSave) {
										HF._overAsking = false;
										/* 选「保存记录并回溯」时先把这次的数据存下来 */
										try { if (alsoSave) { saveRecord(); } } catch (e) { }
										if (doRestore) {
											try {
												restore(snap);
												HF.render();
												refreshUsable();
												toast('已回到起点，对局继续（统计已重置）');
											} catch (e) { console.error('复盘工具：结算前回溯失败', e); }
										}
										else { try { orig.apply(game, args); } catch (e) { } }
									});
									return;
								}
							}
						} catch (e) { }
						return orig.apply(this, arguments);
					};
					game.over._hfWrapped = true;
				} catch (e) { }
			}
			HF.askOver = function (snap, cb) {
				try { buildOverAsk(snap, cb); } catch (e) { cb(false); }
			};
			HF.startGame = function () {
				try {
					if (game._hfStarted) { return; }
					game._hfStarted = true;
					regHooks();
					HF.stat = newStat();
					HF.seqId = 0;
					if (ui.arena) { setTimeout(function () { buildButton(); }, 800); }
				} catch (e) { console.error('复盘工具：初始化出错', e); }
			};

						/* ============ 牌堆分类（为势孙綝这类"看目标数"的武将准备） ============
			   分类规则：
			     己基 = 基本牌里只能对自己用的（桃 / 酒）
			     敌基 = 基本牌里只能对别人用的（杀、火杀、雷杀）
			     己锦 = 锦囊里只对自己的（无中生有 / 闪电）
			     敌锦 = 锦囊里只对别人的（过河拆桥 / 顺手牵羊 / 兵粮寸断 / 乐不思蜀 / 决斗 / 借刀杀人）
			     锦其 = 其他锦囊（南蛮 / 万箭 / 五谷 / 火攻 / 铁索连环 / 桃园结义）
			     装备 = 装备牌
			     废牌 = 出牌阶段根本打不出去的（闪 / 无懈可击）
			   命中不了表里的牌，按 lib.card 的 type 兜底归类，不会漏算张数。 */
			var PILE_CAT = {
				tao: '己基', jiu: '己基',
				sha: '敌基',
				shan: '废牌',
				wuzhong: '己锦', shandian: '己锦',
				guohe: '敌锦', shunshou: '敌锦', juedou: '敌锦', bingliang: '敌锦', lebu: '敌锦', jiedao: '敌锦',
				nanman: '锦其', wanjian: '锦其', wugu: '锦其', huogong: '锦其', tiesuo: '锦其', taoyuan: '锦其',
				wuxie: '废牌'
			};
			/* 己 = 可对自己用（含全体牌）；敌 = 可对他人用。两者会重复计入同一张牌，用来一眼看"能对自己/对别人出多少张" */
			var PILE_USE = {
				tao: { self: 1 }, jiu: { self: 1 },
				wuzhong: { self: 1 }, shandian: { self: 1 },
				tiesuo: { self: 1, other: 1 }, wugu: { self: 1, other: 1 }, taoyuan: { self: 1, other: 1 },
				sha: { other: 1 }, guohe: { other: 1 }, shunshou: { other: 1 }, juedou: { other: 1 },
				jiedao: { other: 1 }, huogong: { other: 1 }, bingliang: { other: 1 }, lebu: { other: 1 },
				nanman: { other: 1 }, wanjian: { other: 1 },
				/* 闪 / 无懈可击：出牌阶段打不出去，两边都不算（空对象＝不归入己也不归入敌） */
				shan: {}, wuxie: {}
			};
			var _useCache = {};
			function cardUse(name) {
				if (!name) { return {}; }
				if (_useCache[name]) { return _useCache[name]; }
				var out = PILE_USE[name];
				if (!out) {
					var ty = (lib.card[name] && lib.card[name].type) || "";
					if (ty === "equip") { out = { self: 1 }; }
					else if (ty === "basic" || ty === "trick" || ty === "delay") { out = { other: 1 }; }
					else { out = {}; }
				}
				return (_useCache[name] = out);
			}
			var PILE_CATS = ['己', '敌', '己基', '敌基', '己锦', '敌锦', '锦其', '装备', '废牌'];
			var _pileCatCache = {};
			function cardCat(name) {
				if (!name) { return "其他"; }
				if (_pileCatCache[name]) { return _pileCatCache[name]; }
				var cat = "其他";
				try {
					if (PILE_CAT[name]) { cat = PILE_CAT[name]; }
					else {
						var type = lib.card[name] ? lib.card[name].type : "";
						if (type === 'equip') { cat = '装备'; }
						else if (type === 'basic') { cat = '敌基'; }
						else if (type === 'trick' || type === 'delay') { cat = '锦其'; }
					}
				} catch (e) { }
				return (_pileCatCache[name] = cat);
			}
			function pileCount() {
				var out = {};
				PILE_CATS.forEach(function (c) { out[c] = 0; });
				var total = 0;
				try {
					var pile = ui.cardPile;
					if (pile) {
						for (var i = 0; i < pile.childNodes.length; i++) {
							var c = pile.childNodes[i];
							if (!c) { continue; }
							total++;
							var cat = cardCat(String(c.name));
							if (out[cat] === undefined) { out[cat] = 0; }
							out[cat]++;
							var use = cardUse(String(c.name));
							if (use.self) { out['己'] = (out['己'] || 0) + 1; }
							if (use.other) { out['敌'] = (out['敌'] || 0) + 1; }
						}
					}
				} catch (e) { }
				return { total: total, cats: out };
			}
			function pileBarText() {
				var d = pileCount();
				var parts = [];
				PILE_CATS.forEach(function (c) { parts.push(c + " " + (d.cats[c] || 0)); });
				return "牌堆 " + d.total + "｜" + parts.join(" ");
			}
			function refreshPileBar() {
				try {
					if (!HF.pileBar || HF.pileBar.style.display === "none") { return; }
					if (HF.pileBar._hfDragOn) { return; }   /* 拖动中不刷新，避免宽度变化把框顶歪 */
					HF.pileBar.innerHTML = pileBarText();
				} catch (e) { }
			}
			function buildPileBar() {
				if (_status.video || _status.connectMode) { return; }
				if (HF.pileBar) { try { HF.pileBar.remove(); } catch (e) { } }
				var bar = el("div", "hf-pilebar");
				restorePos(bar, 'hf_pilebar_pos');
				try { layer().appendChild(bar); } catch (e) { }
				try { ensureOnScreen(bar); } catch (e) { }
				bar.innerHTML = pileBarText();
				HF.pileBar = bar;
				dragify(bar, bar, 'hf_pilebar_pos');
				bindTip(bar, '牌堆按可指定目标分类计数（己基/敌基/己锦/敌锦/锦其/装备/废牌），点「起点」页可关掉');
				if (HF.timer) { clearInterval(HF.timer); }
			}

			/* ================= 5. 界面 =================
			/* 样式表内容由 HF_STYLE 统一生成（见 buildStyleCSS）*/
			var HF_CSS = '';
			/* 关键：本体 CSS 里有 div{display:inline-block;position:absolute;transition:all .5s}，
			   所以自建的每个 div 都必须显式写 position/display，否则会绝对定位飘到左上角叠在一起 */
						/* ===== Cupertino Design Tokens（iOS Dark）=====
			   systemBlue #0A84FF / systemRed #FF453A / systemGreen #30D158；
			   label 白、secondaryLabel rgba(235,235,245,.6)、tertiaryLabel .3；
			   fill rgba(118,118,128,.24)、separator rgba(84,84,88,.65)；
			   组件：Grouped Sheet / Navigation Bar / Segmented Control / Tinted+Filled Button /
			        Inset Grouped List / Rounded Text Field / Alert / HUD / Hairline Table。 */
			var HF_STYLE = {
				/* 悬浮球：只有三层同心圆球 */
				'hf-orbbox': 'transition:none;position:fixed;left:12px;bottom:112px;width:46px;height:46px;z-index:2147483000;touch-action:none;-webkit-user-select:none;user-select:none;',
				'hf-btn': 'position:absolute;left:0;top:0;right:0;bottom:0;border-radius:50%;overflow:hidden;background:#0b1a2e;box-shadow:0 12px 30px -8px rgba(0,106,255,.55),0 4px 12px -2px rgba(0,0,0,.30);transition:transform .5s cubic-bezier(.34,1.56,.64,1),box-shadow .4s;cursor:pointer;box-sizing:border-box;-webkit-tap-highlight-color:rgba(0,0,0,0);touch-action:none;',
				/* 汉堡图标 */
				'hf-icon': 'position:absolute;left:0;top:0;right:0;bottom:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;pointer-events:none;z-index:8;',
				/* 泡泡层 */
				'hf-bubbles': 'position:absolute;left:0;top:0;right:0;bottom:0;z-index:2;pointer-events:none;',
				'hf-slot': 'position:absolute;left:50%;top:50%;width:0;height:0;transition:transform .6s cubic-bezier(.34,1.56,.64,1);',
				'hf-pb': 'position:absolute;left:-19px;top:-19px;width:38px;height:38px;border-radius:50%;border:none;padding:0;cursor:pointer;pointer-events:auto;display:flex;align-items:center;justify-content:center;opacity:0;transform:scale(.3);transition:opacity .3s ease,transform .55s cubic-bezier(.34,1.56,.64,1);-webkit-tap-highlight-color:transparent;outline:none;background:radial-gradient(circle at 30% 24%,rgba(255,255,255,.95) 0%,rgba(255,255,255,0) 18%),radial-gradient(circle at 74% 80%,rgba(255,255,255,.50) 0%,rgba(255,255,255,0) 12%),radial-gradient(circle at 50% 50%,rgba(255,255,255,.02) 55%,rgba(200,240,255,.12) 76%,rgba(255,255,255,.50) 92%,rgba(255,255,255,.90) 100%);box-shadow:inset -4px -6px 14px rgba(120,220,255,.30),inset 4px 6px 14px rgba(255,170,225,.22),0 8px 22px rgba(0,106,255,.35);',
				'hf-panel': 'transition:none !important;position:fixed;left:12px;bottom:10px;width:392px;max-width:94vw;max-height:96vh;z-index:2147483001;background-color:rgba(32,32,32,.88);backdrop-filter:blur(30px) saturate(125%);-webkit-backdrop-filter:blur(30px) saturate(125%);color:#ffffff;border:1px solid rgba(255,255,255,.09);border-radius:18px;font-size:15px;line-height:1.45;font-family:-apple-system,BlinkMacSystemFont,SF Pro Text,PingFang SC,Helvetica Neue,Arial,sans-serif;display:flex;flex-direction:column;overflow:hidden;pointer-events:auto;box-shadow:inset 0 1px 0 rgba(255,255,255,.10),inset 0 0 0 1px rgba(255,255,255,.03),0 24px 64px rgba(0,0,0,.6);-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:rgba(0,0,0,0);box-sizing:border-box;',
				'hf-head': 'position:relative;display:flex;align-items:center;flex:0 0 auto;height:44px;padding:0 10px 0 14px;background:rgba(44,44,46,.72);backdrop-filter:blur(30px) saturate(180%);-webkit-backdrop-filter:blur(30px) saturate(180%);border-bottom:.5px solid rgba(84,84,88,.65);cursor:move;touch-action:none;box-sizing:border-box;',
				'hf-handle': 'position:relative;display:block;flex:0 0 auto;color:rgba(235,235,245,.3);font-size:15px;margin-right:8px;letter-spacing:-1px;',
				'hf-title': 'position:relative;display:block;flex:1;font-size:17px;font-weight:600;color:#ffffff;text-align:center;letter-spacing:-.4px;font-family:-apple-system,BlinkMacSystemFont,SF Pro Text,PingFang SC,Helvetica Neue,Arial,sans-serif;',
				/* 按钮：和悬浮球同色系，小一号 */
				/* 主按钮稍微亮一点 */
				'hf-close': 'position:relative;display:flex;align-items:center;justify-content:center;flex:0 0 auto;width:30px;height:30px;border-radius:15px;background:rgba(120,120,128,.36);color:rgba(235,235,245,.6);font-size:15px;font-weight:600;cursor:pointer;margin-left:8px;',
				'hf-dragging': 'opacity:.88;',
				'hf-tabs': 'position:relative;display:flex;flex:0 0 auto;gap:2px;margin:10px 12px 6px;padding:2px;background:rgba(118,118,128,.24);border-radius:10px;box-sizing:border-box;',
				'hf-tab': 'position:relative;display:block;flex:1;text-align:center;padding:6px 0;border-radius:8px;font-size:13px;font-weight:500;color:rgba(235,235,245,.6);cursor:pointer;letter-spacing:-.1px;font-family:-apple-system,BlinkMacSystemFont,SF Pro Text,PingFang SC,Helvetica Neue,Arial,sans-serif;',
				'hf-tab-on': 'position:relative;display:block;flex:1;text-align:center;padding:6px 0;border-radius:8px;font-size:13px;font-weight:600;color:#ffffff;background:#636366;box-shadow:0 1px 3px rgba(0,0,0,.35);cursor:pointer;font-family:-apple-system,BlinkMacSystemFont,SF Pro Text,PingFang SC,Helvetica Neue,Arial,sans-serif;',
				'hf-body': 'position:relative;display:block;box-sizing:border-box;flex:1 1 auto;min-height:0;max-height:calc(96vh - 118px);padding:4px 12px 14px;overflow-y:auto;-webkit-overflow-scrolling:touch;touch-action:pan-y;',
				'hf-row': 'position:relative;display:flex;flex-wrap:wrap;gap:8px;margin:0 0 12px;',
				'hf-btnrow': 'position:relative;display:flex;align-items:center;justify-content:center;flex:1 1 auto;min-height:44px;box-sizing:border-box;text-align:center;background:rgba(118,118,128,.24);color:#0A84FF;border:none;border-radius:12px;padding:11px 10px;font-size:15px;font-weight:600;letter-spacing:-.2px;font-family:-apple-system,BlinkMacSystemFont,SF Pro Text,PingFang SC,Helvetica Neue,Arial,sans-serif;cursor:pointer;',
				'hf-inp': 'position:relative;display:block;flex:2 1 160px;',
				'hf-input': 'position:relative;display:block;width:100%;box-sizing:border-box;background:rgba(118,118,128,.24);color:#ffffff;border:none;border-radius:10px;padding:11px 12px;font-size:15px;font-family:-apple-system,BlinkMacSystemFont,SF Pro Text,PingFang SC,Helvetica Neue,Arial,sans-serif;-webkit-user-select:text;user-select:text;',
				'hf-sec': 'position:relative;display:block;margin:16px 4px 6px;color:rgba(235,235,245,.6);font-size:13px;font-weight:600;letter-spacing:.2px;font-family:-apple-system,BlinkMacSystemFont,SF Pro Text,PingFang SC,Helvetica Neue,Arial,sans-serif;',
				'hf-kv': 'position:relative;display:block;white-space:pre-wrap;word-break:break-all;font-size:14px;line-height:1.5;color:rgba(235,235,245,.92);font-family:-apple-system,BlinkMacSystemFont,SF Pro Text,PingFang SC,Helvetica Neue,Arial,sans-serif;',
				'hf-dim': 'position:relative;display:inline;color:rgba(235,235,245,.3);',
				'hf-cards': 'position:relative;display:flex;flex-wrap:wrap;gap:6px;max-height:16vh;overflow-y:auto;',
				'hf-card': 'position:relative;display:block;flex:0 0 auto;background:rgba(118,118,128,.24);color:#0A84FF;border:none;border-radius:8px;padding:6px 10px;cursor:pointer;font-size:13px;font-weight:500;font-family:-apple-system,BlinkMacSystemFont,SF Pro Text,PingFang SC,Helvetica Neue,Arial,sans-serif;',
				'hf-cmp': 'position:relative;display:block;white-space:normal;word-break:break-all;background:rgba(118,118,128,.12);border-radius:12px;padding:10px;font-size:13px;font-family:-apple-system,BlinkMacSystemFont,SF Pro Text,PingFang SC,Helvetica Neue,Arial,sans-serif;',
				'hf-tip': 'position:relative;display:block;color:rgba(235,235,245,.3);font-size:12px;margin-top:6px;line-height:1.4;font-family:-apple-system,BlinkMacSystemFont,SF Pro Text,PingFang SC,Helvetica Neue,Arial,sans-serif;',
				'hf-on': 'background:#0A84FF;color:#ffffff;box-shadow:0 1px 3px rgba(10,132,255,.4);',
				'hf-pilebar': 'transition:none !important;position:fixed;right:8px;top:56px;max-width:94vw;padding:9px 12px;background-color:rgba(32,32,32,.88);backdrop-filter:blur(30px) saturate(125%);-webkit-backdrop-filter:blur(30px) saturate(125%);color:rgba(235,235,245,.92);border:1px solid rgba(255,255,255,.09);border-radius:14px;font-size:12px;line-height:1.4;font-family:-apple-system,BlinkMacSystemFont,SF Pro Text,PingFang SC,Helvetica Neue,Arial,sans-serif;z-index:2147482999;pointer-events:auto;cursor:move;display:block;white-space:normal;word-break:break-all;box-shadow:inset 0 1px 0 rgba(255,255,255,.10),0 8px 24px rgba(0,0,0,.45);-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:rgba(0,0,0,0);',
				'hf-tb': 'width:100%;table-layout:fixed;border-collapse:collapse;font-size:13px;color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,SF Pro Text,PingFang SC,Helvetica Neue,Arial,sans-serif;',
				'hf-tbc': 'width:64px;',
				'hf-crow': 'position:relative;display:flex;flex-wrap:nowrap;align-items:center;height:24px;line-height:24px;border-bottom:.5px solid rgba(84,84,88,.5);',
				'hf-ck': 'position:relative;display:block;flex:0 0 64px;color:rgba(235,235,245,.6);font-size:12px;height:24px;line-height:24px;overflow:hidden;white-space:nowrap;font-family:-apple-system,BlinkMacSystemFont,SF Pro Text,PingFang SC,Helvetica Neue,Arial,sans-serif;',
				'hf-cv': 'position:relative;display:block;flex:1 1 0;min-width:0;font-size:13px;height:24px;line-height:24px;text-align:center;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-family:-apple-system,BlinkMacSystemFont,SF Pro Text,PingFang SC,Helvetica Neue,Arial,sans-serif;',
				'hf-ch': 'position:relative;display:block;flex:1 1 0;min-width:0;font-size:12px;height:24px;line-height:24px;text-align:center;color:rgba(235,235,245,.6);font-weight:600;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-family:-apple-system,BlinkMacSystemFont,SF Pro Text,PingFang SC,Helvetica Neue,Arial,sans-serif;',
				'hf-cs': 'position:relative;display:block;flex:1 1 0;min-width:0;font-size:12px;height:22px;line-height:22px;text-align:center;color:rgba(235,235,245,.6);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-family:-apple-system,BlinkMacSystemFont,SF Pro Text,PingFang SC,Helvetica Neue,Arial,sans-serif;',
				'hf-cks': 'position:relative;display:block;flex:0 0 64px;color:rgba(235,235,245,.3);font-size:12px;height:22px;line-height:22px;overflow:hidden;white-space:nowrap;font-family:-apple-system,BlinkMacSystemFont,SF Pro Text,PingFang SC,Helvetica Neue,Arial,sans-serif;',
				'hf-chain': 'position:relative;display:block;font-size:12px;line-height:1.45;padding:9px 11px;margin:0 0 8px 0;background:rgba(118,118,128,.12);border-radius:10px;white-space:normal;word-break:break-all;font-family:-apple-system,BlinkMacSystemFont,SF Pro Text,PingFang SC,Helvetica Neue,Arial,sans-serif;',
				'hf-bubble': 'transition:opacity .25s ease !important;position:fixed;left:50%;bottom:120px;transform:translateX(-50%);max-width:92vw;padding:11px 16px;background:rgba(28,28,30,.86);backdrop-filter:blur(30px) saturate(180%);-webkit-backdrop-filter:blur(30px) saturate(180%);color:#ffffff;border:.5px solid rgba(255,255,255,.12);border-radius:14px;font-size:13px;line-height:1.4;font-family:-apple-system,BlinkMacSystemFont,SF Pro Text,PingFang SC,Helvetica Neue,Arial,sans-serif;z-index:2147483003;pointer-events:none;display:none;text-align:center;white-space:normal;word-break:break-all;box-shadow:0 12px 32px rgba(0,0,0,.5);',
				'hf-ask': 'transition:none !important;position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:300px;max-width:92vw;padding:20px;background:rgba(44,44,46,.72);backdrop-filter:blur(30px) saturate(180%);-webkit-backdrop-filter:blur(30px) saturate(180%);color:#ffffff;border:.5px solid rgba(255,255,255,.12);border-radius:16px;font-size:15px;line-height:1.5;font-family:-apple-system,BlinkMacSystemFont,SF Pro Text,PingFang SC,Helvetica Neue,Arial,sans-serif;z-index:2147483002;display:block;box-shadow:0 24px 64px rgba(0,0,0,.65);pointer-events:auto;box-sizing:border-box;',
				'hf-askrow': 'position:relative;display:flex;flex-wrap:wrap;gap:8px;margin-top:16px;',
				'hf-rec': 'position:relative;display:flex;flex-wrap:wrap;align-items:center;background:rgba(118,118,128,.12);border:none;border-radius:10px;padding:9px 12px;margin:0 0 6px 0;cursor:pointer;font-size:13px;line-height:1.35;font-family:-apple-system,BlinkMacSystemFont,SF Pro Text,PingFang SC,Helvetica Neue,Arial,sans-serif;',
				'hf-rec-pick': 'position:relative;display:flex;flex-wrap:wrap;align-items:center;background:rgba(10,132,255,.22);border:none;border-radius:10px;padding:9px 12px;margin:0 0 6px 0;cursor:pointer;font-size:13px;line-height:1.35;font-family:-apple-system,BlinkMacSystemFont,SF Pro Text,PingFang SC,Helvetica Neue,Arial,sans-serif;',
			};
			/* 给 innerHTML 拼接用的内联样式片段 */
						var S = {};
			S.row = ' style="position:relative;display:flex;flex-wrap:wrap;gap:8px;margin:0 0 12px;"';
			S.kv = ' style="position:relative;display:block;white-space:pre-wrap;word-break:break-all;font-size:14px;line-height:1.5;color:rgba(235,235,245,.92);"';
			S.sec = ' style="position:relative;display:block;margin:16px 4px 6px;color:rgba(235,235,245,.6);font-size:13px;font-weight:600;letter-spacing:.2px;"';
			S.dim = ' style="position:relative;display:inline;color:rgba(235,235,245,.3);"';
			S.tip = ' style="position:relative;display:block;color:rgba(235,235,245,.3);font-size:12px;margin-top:6px;line-height:1.4;"';
			S.cards = ' style="position:relative;display:flex;flex-wrap:wrap;gap:6px;max-height:16vh;overflow-y:auto;"';
			S.cmp = ' style="position:relative;display:block;white-space:normal;word-break:break-all;background:rgba(118,118,128,.12);border-radius:12px;padding:10px;font-size:13px;"';
			S.rec = ' style="position:relative;display:flex;flex-wrap:wrap;align-items:center;background:rgba(118,118,128,.12);border:none;border-radius:10px;padding:9px 12px;margin:0 0 6px 0;cursor:pointer;font-size:13px;line-height:1.35;"';
			S.recPick = ' style="position:relative;display:flex;flex-wrap:wrap;align-items:center;background:rgba(10,132,255,.22);border:none;border-radius:10px;padding:9px 12px;margin:0 0 6px 0;cursor:pointer;font-size:13px;line-height:1.35;"';
			S.tb = ' style="width:100%;table-layout:fixed;border-collapse:collapse;font-size:13px;color:#ffffff;"';
			S.tbc = ' style="width:64px;"';
			S.ck = ' style="position:relative;display:block;flex:0 0 64px;color:rgba(235,235,245,.6);font-size:12px;line-height:1.3;padding:1px 2px;"';
			S.cv = ' style="position:relative;display:block;flex:1 1 40%;white-space:normal;word-break:break-all;"';
			S.cv2 = ' style="position:relative;display:block;flex:1 1 40%;white-space:normal;word-break:break-all;color:#30D158;"';
			S.crow = ' style="position:relative;display:flex;flex-wrap:nowrap;align-items:center;height:24px;line-height:24px;border-bottom:.5px solid rgba(84,84,88,.5);"';
			S.chain = ' style="position:relative;display:block;font-size:12px;line-height:1.45;padding:9px 11px;margin:0 0 8px 0;background:rgba(118,118,128,.12);border-radius:10px;white-space:normal;word-break:break-all;"';
			/* 由 HF_STYLE 生成 CSS：JS 与样式表永远一致 */
			function buildStyleCSS() {
				var out = '';
				try {
					for (var k in HF_STYLE) {
						if (!HF_STYLE.hasOwnProperty(k)) { continue; }
						if (k === 'hf-tab-on') { out += '.hf-tab.hf-sel{' + HF_STYLE[k] + '}'; }
						else if (k === 'hf-rec-pick') { out += '.hf-rec.hf-pick{' + HF_STYLE[k] + '}'; }
						else if (k === 'hf-input') { out += '.hf-panel input{' + HF_STYLE[k] + '}'; }
						else { out += '.' + k + '{' + HF_STYLE[k] + '}'; }
					}
					/* ===== Fluent Design · Acrylic（亚克力）材质：噪点纹理 + 顶部 1px 光度描边 ===== */
				var ACRYLIC_NOISE = 'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'120\' height=\'120\'><filter id=\'n\'><feTurbulence type=\'fractalNoise\' baseFrequency=\'0.9\' numOctaves=\'3\' stitchTiles=\'stitch\'/></filter><rect width=\'120\' height=\'120\' filter=\'url(%23n)\' opacity=\'0.5\'/></svg>")';
				var ACRYLIC = 'background-image:' + ACRYLIC_NOISE + ';background-repeat:repeat;background-size:120px 120px;background-blend-mode:overlay;backdrop-filter:blur(30px) saturate(125%);-webkit-backdrop-filter:blur(30px) saturate(125%);border:1px solid rgba(255,255,255,.09);box-shadow:inset 0 1px 0 rgba(255,255,255,.10),inset 0 0 0 1px rgba(255,255,255,.03),0 24px 64px rgba(0,0,0,.6);';
				out += '.hf-panel{' + ACRYLIC + '}';
				out += '.hf-pilebar{background-image:' + ACRYLIC_NOISE + ';background-repeat:repeat;background-size:120px 120px;background-blend-mode:overlay;backdrop-filter:blur(30px) saturate(125%);-webkit-backdrop-filter:blur(30px) saturate(125%);border:1px solid rgba(255,255,255,.09);box-shadow:inset 0 1px 0 rgba(255,255,255,.10),0 8px 24px rgba(0,0,0,.45);}';
				/* ===== Cupertino 组件补充规则 ===== */
				out += '.hf-panel,.hf-panel *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,SF Pro Text,PingFang SC,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;}';
								/* ===== 水波球 & 泡泡菜单===== */
				out += '.hf-btn.hf-on{box-shadow:0 0 0 2px rgba(10,132,255,.6),0 12px 30px -8px rgba(0,106,255,.8);}';
				out += '.hf-btn:active{transform:scale(.94);}';
				out += '.hf-icon span{display:block;width:13px;height:2px;border-radius:99px;background:#fff;box-shadow:0 1px 5px rgba(0,60,140,.6);transition:transform .4s cubic-bezier(.68,-.6,.32,1.6),opacity .25s;}';
				out += '.hf-orbbox.hf-open .hf-icon span:nth-child(1){transform:translateY(5px) rotate(45deg);}';
				out += '.hf-orbbox.hf-open .hf-icon span:nth-child(2){opacity:0;transform:scaleX(.2);}';
				out += '.hf-orbbox.hf-open .hf-icon span:nth-child(3){transform:translateY(-5px) rotate(-45deg);}';
				out += '.hf-orbbox.hf-open .hf-pb{opacity:1;transform:scale(1);}';
				out += '.hf-orbbox.hf-open .hf-pb:active{transform:scale(.92);}';
				out += '.hf-pb svg{position:relative;z-index:2;display:block;color:#fff;filter:drop-shadow(0 1px 3px rgba(0,50,120,.65));}';
				out += '.hf-pb::after{content:"";position:absolute;inset:-1px;border-radius:50%;background:conic-gradient(from 200deg,rgba(255,100,190,.55),rgba(110,200,255,.55),rgba(140,255,210,.50),rgba(255,240,150,.50),rgba(190,130,255,.55),rgba(255,100,190,.55));-webkit-mask:radial-gradient(circle,transparent 55%,#000 84%,#000 95%,transparent 100%);mask:radial-gradient(circle,transparent 55%,#000 84%,#000 95%,transparent 100%);mix-blend-mode:screen;opacity:.8;pointer-events:none;}';
				out += '@media (prefers-reduced-motion: reduce){.hf-wave::before,.hf-wave::after{animation:none !important;}}';

				out += '.hf-panel input{outline:none;border:none;}';
				out += '.hf-panel input::placeholder{color:rgba(235,235,245,.3);}';
				out += '.hf-btnrow:active,.hf-tab:active,.hf-card:active,.hf-close:active,.hf-rec:active,.hf-btn:active{opacity:.62;}';
				out += '.hf-btn.hf-on{background:#0A84FF;color:#fff;border:none;}';
				/* （旧的右侧按钮组已移除，对应的 .hf-actbtn 规则一并删掉） */
				/* 悬浮球内圈（AssistiveTouch 式） */
				/* ===== 悬浮球「液体波动」动画=====
				   .hf-wave 是液体本体；它的两个伪元素是两层旋转的浪头。 */
				out += '@keyframes hf-rotate{from{transform:rotate(0)}to{transform:rotate(1turn)}}';
				out += '.hf-wave{--wave-light:#00DCFF;--wave-dark:#006AFF;position:absolute;left:0;top:0;width:100%;height:100%;border-radius:50%;overflow:hidden;background-image:linear-gradient(-180deg,var(--wave-light) 13%,var(--wave-dark) 91%);}';
				out += '.hf-wave::before,.hf-wave::after{content:"";position:absolute;left:50%;top:0;width:200%;height:200%;margin-left:-100%;}';
				out += '.hf-wave::before{margin-top:-150%;border-radius:45%;background-color:rgba(255,255,255,.28);animation:hf-rotate 9s linear -4s infinite;}';
				out += '.hf-wave::after{margin-top:-160%;border-radius:40%;background-color:rgba(255,255,255,.16);animation:hf-rotate 13s linear infinite;}';
				out += '.hf-btn::before{content:"";box-sizing:border-box;position:absolute;left:0;right:0;top:0;bottom:0;margin:auto;width:38px;height:38px;background:transparent;border-radius:50%;border:1px solid rgba(255,255,255,.18);pointer-events:none;z-index:2;}';
				out += '.hf-btn.hf-on::before{border-color:rgba(255,255,255,.35);}';
				/* （30px 白环已删，这条一并去掉） */
				out += '.hf-panel b{font-weight:600;color:#fff;}';
				out += '.hf-tb td,.hf-tb th{height:24px;line-height:24px;padding:0 4px;font-size:13px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-bottom:.5px solid rgba(84,84,88,.5);box-sizing:border-box;}';
				out += '.hf-tb th{font-size:11px;font-weight:600;color:rgba(235,235,245,.6);letter-spacing:.4px;background:transparent;}';
				out += '.hf-tb tr.hf-sub td{font-size:12px;color:rgba(235,235,245,.6);height:22px;line-height:22px;}';
				out += '.hf-tb td.hf-tk{color:rgba(235,235,245,.6);}';
				out += '.hf-tb tr:last-child td{border-bottom:none;}';
				out += '.hf-body::-webkit-scrollbar,.hf-cmp::-webkit-scrollbar,.hf-cards::-webkit-scrollbar{width:3px;}';
				out += '.hf-body::-webkit-scrollbar-thumb,.hf-cmp::-webkit-scrollbar-thumb{background:rgba(235,235,245,.25);border-radius:2px;}';
				out += '.hf-body::-webkit-scrollbar-track,.hf-cmp::-webkit-scrollbar-track{background:transparent;}';

				} catch (e) { }
				return out;
			}
			function sty(node, css) {
				try { node.style.cssText = (node.style.cssText || '') + ';' + css; } catch (e) { }
				return node;
			}
			function injectCSS() {
				try {
					if (document.getElementById('hf-style')) { return; }
					var s = document.createElement('style');
					s.id = 'hf-style';
					s.type = 'text/css';
					try {
						if (s.styleSheet) { s.styleSheet.cssText = HF_CSS + buildStyleCSS(); }               /* 老 WebView */
						else { s.appendChild(document.createTextNode(HF_CSS + buildStyleCSS())); }            /* 标准写法 */
					} catch (e2) { s.innerHTML = HF_CSS + buildStyleCSS(); }
					(document.head || document.body || document.documentElement).appendChild(s);
				} catch (e) { }
			}
			injectCSS();
			/* 附带也尝试加载外置样式 */
			try { lib.init.css(lib.assetURL + 'extension/复盘工具/', 'extension'); } catch (e) { }

			/* 移动端点击：touchend + click 双绑；只有"明显移动"过才算拖动，否则一律当点击（
			   手机上手指点一下也会有 1~5px 抖动，必须给阈值） */
			function onTap(node, fn) {
				if (!node) { return; }
				var sx = 0, sy = 0, moved = false, last = 0;
				node.addEventListener('touchstart', function (e) {
					var t = e.touches && e.touches[0];
					sx = t ? t.clientX : 0; sy = t ? t.clientY : 0; moved = false;
				}, { passive: true });
				node.addEventListener('touchmove', function (e) {
					var t = e.touches && e.touches[0];
					if (!t) { return; }
					if (Math.abs(t.clientX - sx) + Math.abs(t.clientY - sy) > 14) { moved = true; }
				}, { passive: true });
				node.addEventListener('touchend', function (e) {
					if (moved) { moved = false; return; }
					last = Date.now();
					try { if (e.cancelable) { e.preventDefault(); } } catch (err) { }
					fn(e);
				});
				node.addEventListener('click', function (e) {
					if (moved) { moved = false; return; }
					if (Date.now() - last < 600) { return; }
					fn(e);
				});
			}

						/* 自带的小气泡：不依赖游戏战报，长按提示才能看见 */
			function hfToast(text) {
				try {
					if (!HF.bubble) { HF.bubble = el("div", "hf-bubble", layer()); }
					var b = HF.bubble;
					b.innerHTML = text;
					b.style.display = 'block';
					if (HF.bubbleTimer) { clearTimeout(HF.bubbleTimer); }
					HF.bubbleTimer = setTimeout(function () { try { b.style.display = 'none'; } catch (e) { } }, 3000);
				} catch (e) { }
			}
			/* 长按按钮 0.55 秒弹说明 */
			function bindTip(node, tip) {
				if (!node || !tip) { return; }
				node._hfTip = tip;
				var timer = null, sx = 0, sy = 0;
				var clear = function () { if (timer) { clearTimeout(timer); timer = null; } };
				var start = function (e) {
					var p = e && e.touches ? e.touches[0] : e;
					sx = p && p.clientX ? p.clientX : 0;
					sy = p && p.clientY ? p.clientY : 0;
					clear();
					timer = setTimeout(function () { timer = null; hfToast("提示：" + tip); }, 550);
				};
				var maybeClear = function (e) {
					var p = e && e.touches ? e.touches[0] : e;
					if (!p || !p.clientX) { return clear(); }
					if (Math.abs(p.clientX - sx) + Math.abs(p.clientY - sy) > 10) { clear(); }
				};
				node.addEventListener('touchstart', start, { passive: true });
				node.addEventListener('touchmove', maybeClear, { passive: true });
				node.addEventListener('touchend', clear, { passive: true });
				node.addEventListener('touchcancel', clear, { passive: true });
				node.addEventListener('mousedown', start);
				node.addEventListener('mousemove', maybeClear);
				node.addEventListener('mouseup', clear);
				node.addEventListener('mouseleave', clear);
			}

			/* 把记住的位置应用到节点上（要在插入 DOM 之前调用） */
			function restorePos(node, saveKey) {
				if (!node || !saveKey) { return; }
				try {
					var s = JSON.parse(localStorage.getItem(saveKey) || 'null');
					var vw = window.innerWidth || 360, vh = window.innerHeight || 640;
					if (s && s.left && s.top) {
						var x = parseInt(s.left) || 0, y = parseInt(s.top) || 0;
						if (x >= 0 && y >= 0 && x < vw - 30 && y < vh - 30) {
							node.style.left = x + 'px';
							node.style.top = y + 'px';
							node.style.bottom = 'auto';
							node.style.right = 'auto';
						}
					}
				} catch (e) { }
			}
			/* 拖动：手柄上按下后移动超过阈值才开始拖；松手时贴边并记住位置 */
						/* 拖动：优先 Pointer Events + setPointerCapture，
			   位移用 transform（GPU 合成，不触发布局），松手再写回 left/top 并贴边。
			   这是"手感"的关键：以前每次 touchmove 都改 left/top，浏览器要重排整个浮层。 */
						/* 拖动：最朴素的 left/top（不玩 transform / 指针捕获，手机上越简单越稳）。
			   按下瞬间记录基准并转左/上锚点；移动才改位置；松手精确停在手指处。
			   触摸结束后的 350ms 内忽略鼠标事件。 */
						/* 拖动（按参考实现 suspensionBall 的算法重写）
			   要点：
			     1) 按下时用 offsetLeft/offsetTop 算"手指在元素内部的位置" disX/disY；
			        移动时 left = clientX - disX —— 不碰 getBoundingClientRect，
			        所以不会被缩放、变形、锚点（bottom/right）干扰，按下即跟手。
			     2) 按下瞬间就把 bottom/right 换成 left/top（锁死当前坐标），避免锚点切换跳动。
			     3) move/end 监听在 document 上"按需挂载、结束即卸载"，不残留监听、不重复触发。
			     4) 只写有限数值（isFinite），绝不把 NaN 写进 style（那会让元素直接消失）。 */
			/* snapEdge=true 时启用"贴边吸附"：松手离左右边缘 70px 内就平滑吸过去 */
			function dragify(node, handle, saveKey, snapEdge) {
				if (!node) { return; }
				var target = handle || node;
				/* 触摸优先 */
				var startEvt, moveEvt, endEvt;
				if ('ontouchstart' in window) { startEvt = 'touchstart'; moveEvt = 'touchmove'; endEvt = 'touchend'; }
				else { startEvt = 'mousedown'; moveEvt = 'mousemove'; endEvt = 'mouseup'; }
				var disX = 0, disY = 0, moved = false, bound = false;
				/* 标题栏里的 ✕、按钮、输入框不参与拖动 */
				var isBtn = function (e) {
					try {
						var el2 = e.target;
						while (el2 && el2 !== node) {
							if (el2.classList && (el2.classList.contains("hf-close") || el2.classList.contains("hf-btnrow") || el2.tagName === "INPUT")) { return true; }
							el2 = el2.parentNode;
						}
					} catch (err) { }
					return false;
				};
				var vw = function () { return document.documentElement.clientWidth || window.innerWidth || 360; };
				var vh = function () { return document.documentElement.clientHeight || window.innerHeight || 640; };
				function moveFun(e) {
					var ev = e || window.event;
					var pt = ev.touches ? ev.touches[0] : ev;
					if (!pt || typeof pt.clientX !== "number" || !isFinite(pt.clientX) || !isFinite(pt.clientY)) { return; }
					var left = pt.clientX - disX;
					var top = pt.clientY - disY;
					var w = node.offsetWidth || 46, h = node.offsetHeight || 46;
					if (left < 0) { left = 0; } else if (left > vw() - w) { left = vw() - w; }
					if (top < 0) { top = 0; } else if (top > vh() - h) { top = vh() - h; }
					node.style.left = Math.round(left) + "px";
					node.style.top = Math.round(top) + "px";
					moved = true;
					if (ev.cancelable) { try { ev.preventDefault(); } catch (e2) { } }
				}
				function endFun() {
					try { document.removeEventListener(moveEvt, moveFun); document.removeEventListener(endEvt, endFun); } catch (e) { }
					bound = false;
					node._hfDragOn = false;
					/* ===== 贴边吸附 =====
					   离左右边缘 70px 以内就吸过去；用一次性 transition 让它滑过去 */
					if (moved && snapEdge) {
						try {
							var vw2 = document.documentElement.clientWidth || window.innerWidth || 360;
							var w2 = node.offsetWidth || 46;
							var l2 = node.offsetLeft || 0;
							var rightDist = vw2 - l2 - w2;
							if (l2 <= 70 || rightDist <= 70) {
								var targetL = (l2 <= rightDist) ? 6 : Math.max(6, vw2 - w2 - 6);
								node.style.transition = "left .28s ease, top .28s ease";
								node.style.left = Math.round(targetL) + "px";
								setTimeout(function () { try { node.style.transition = "none"; } catch (e) { } }, 340);							}
						} catch (e) { }
					}
					if (moved && saveKey) {
						try { localStorage.setItem(saveKey, JSON.stringify({ left: node.style.left, top: node.style.top })); } catch (e) { }
					}
					if (moved) {
						try { if (typeof HF.relayoutBubbles === "function") { HF.relayoutBubbles(); setTimeout(HF.relayoutBubbles, 380); } } catch (e) { }
					}
					target._hfMoved = moved;
				}
				target.addEventListener(startEvt, function (e) {
					var ev = e || window.event;
					if (isBtn(ev)) { return; }
					var pt = ev.touches ? ev.touches[0] : ev;
					if (!pt || typeof pt.clientX !== "number" || !isFinite(pt.clientX) || !isFinite(pt.clientY)) { return; }
					/* 手指相对元素左上角的位置（布局值，最稳） */
					disX = pt.clientX - (node.offsetLeft || 0);
					disY = pt.clientY - (node.offsetTop || 0);
					try {
						node.style.left = (node.offsetLeft || 0) + "px";
						node.style.top = (node.offsetTop || 0) + "px";
						node.style.right = "auto";
						node.style.bottom = "auto";
						node.style.transition = "none";
					} catch (err) { }
					moved = false;
					node._hfDragOn = true;
					if (!bound) {
						bound = true;
						try { document.addEventListener(moveEvt, moveFun, { passive: false }); } catch (err) { document.addEventListener(moveEvt, moveFun); }
						document.addEventListener(endEvt, endFun);
					}
					/* 阻止页面滚动/缩放 */
					if (ev.cancelable) { try { ev.preventDefault(); } catch (err) { } }
				}, { passive: false });
			}


			/* 显示时校验：位置出屏就拉回来 */
			function ensureOnScreen(node) {
				try {
					var vw = window.innerWidth || 360, vh = window.innerHeight || 640;
					var r = node.getBoundingClientRect();
					if (!r || r.width <= 0 || r.height <= 0) { return; }
					/* 只有"大部分出屏"才拉回：轻微超出保持用户放的位置，
					   否则每次打开都会把面板硬拽回屏幕内，看起来就是"记不住位置" */
					var visW = Math.min(vw, r.left + r.width) - Math.max(0, r.left);
					var visH = Math.min(vh, r.top + r.height) - Math.max(0, r.top);
					var needFix = (visW < r.width * 0.5) || (visH < Math.min(r.height * 0.35, 180)) || (r.top > vh - 40);
					if (needFix) {
						var l = Math.max(4, Math.min(vw - r.width - 4, Math.round(r.left)));
						var tp = Math.max(4, Math.min(vh - r.height - 4, Math.round(r.top)));
						node.style.left = l + 'px';
						node.style.top = tp + 'px';
						node.style.right = 'auto';
						node.style.bottom = 'auto';
					}
				} catch (e) { }
			}



			/* 挂到 <html> 上：游戏 game.updatez() 会给 body 加 transform:scale(game.documentZoom)，
			   挂在 body 里的浮层会跟着被缩小，而且 style 坐标是「缩放前单位」、
			   getBoundingClientRect() 却是屏幕单位（本体自己到处都在 /game.documentZoom）。
			   挂 html 上就完全不受缩放影响，坐标 = 屏幕坐标，拖拽不会跑偏。 */
			function layer() {
				try { if (document.documentElement) { return document.documentElement; } } catch (e) { }
				try { return document.body || ui.window; } catch (e) { return ui.window; }
			}

						/* ===== 悬浮球（水波球 + 泡泡菜单；样式来自 3.html，尺寸保持 46px）=====
			   单击球 → 弹/收 3 个泡泡（记录 / 重来 / 结束）
			   双击球（300ms 内两次单击）→ 打开面板
			   泡泡按球在屏幕左/右半屏自动选"朝右上"或"朝左上"的弧线，避免飞出屏幕 */
			function buildButton() {
				if (_status.video || _status.connectMode) return;
				injectCSS();
				if (HF.btn) { try { HF.btn.remove(); } catch (e) { } }
				var box = el("div", "hf-orbbox");
				HF.btn = box;
				restorePos(box, "hf_btn_pos");
				var orb = el("div", "hf-btn", box);
				HF.orb = orb;
				el("div", "hf-wave", orb);
				el("div", "hf-icon", orb, "<span></span><span></span><span></span>");
				var bub = el("div", "hf-bubbles", box);
				HF.bubbles = bub;
				/* 前三个泡泡的图标用 3.html 里那三个 SVG；第四个「设置」用齿轮（用户给的素材）。				   顺序固定：① 记录 ② 重来 ③ 停止（结束）④ 设置。 */
				var ICONS = [
					/* 图标来自新版 3.html：播放 ▶ / 刷新 ↻ / 停止 ■（分别对应 记录 / 重来 / 结束） */
					'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="7 4 20 12 7 20 7 4" fill="currentColor" stroke="none"/></svg>',
					'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
					'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/></svg>',
					/* 设置（齿轮）：打开 / 收起复盘面板 —— 取代原来的"双击球" */
					'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'
				];
				var ACTS = [
					{ label: "记录", tip: "记录起点：把现在这一刻存下来并开始统计（开了自动快照就不需要它）", need: function () { return !HF.cfg.autoSnap; }, run: function () { HF.recordStart(); } },
					{ label: "重来", tip: "重来：先存一条记录，再回到起点重新试；没有起点（也没开自动快照）时会提示先记录起点，不会动你的牌（开了「默认命名」就不弹框）", need: function () { return true; }, run: function () { if (!HF.usableStart()) { HF.noStartTip(); return; } try { saveRecord(); } catch (e) { } HF.backToStart(); } },
					{ label: "结束", tip: "结束（■ 停止）：存一条记录并跳到「记录」页看对比；起名时点取消就不保存、也不跳页（开了「默认命名」就不弹框）", need: function () { return true; }, run: function () { var ok2 = false; try { ok2 = (saveRecord() !== false); } catch (e) { } if (!ok2) { return; }   /* 取消了就不跳页 */ if (!HF.open) { HF.toggle(true); } HF.setTab("rec"); } },
					/* 第四个：设置（齿轮）→ 打开 / 收起面板。以前是"双击球"，现在改成点这个泡泡 */
					{ label: "设置", tip: "设置（齿轮）：打开 / 收起复盘面板", need: function () { return true; }, run: function () { HF.toggle(); } }
				];
				HF.slots = [];
				ACTS.forEach(function (a, i) {
					var slot = el("div", "hf-slot", bub);
					var b = el("button", "hf-pb", slot, ICONS[i]);
					b.setAttribute("aria-label", a.label);
					b.setAttribute("title", a.label);
					bindTip(b, a.tip);
					/* 收起状态下不可点击：否则它们 opacity:0 叠在球心，点球会误触发泡泡 */
					b.style.pointerEvents = "none";
					onTap(b, function (e) {
						/* 双保险：还没飞到位（或已收起）时这一下不算 —— 否则双击的第二下会落在
						还压在球心的【结束】泡泡上，误触发「停止」 */
						if (b.style.pointerEvents !== "auto") { return; }
						try { if (e && e.stopPropagation) { e.stopPropagation(); } } catch (err) { }
						HF.closeBubbles();
						a.run();
					});
					HF.slots.push({ slot: slot, btn: b, act: a });
				});
				try { layer().appendChild(box); } catch (e) { }
				try { ensureOnScreen(box); } catch (e) { }
				dragify(box, orb, "hf_btn_pos", true);   /* 拖球移动；true = 贴边吸附 */
				/* 单击球：只管开合泡泡。面板改成点第四个泡泡【设置】打开（不再用双击） */
				HF.resetTap = function () { };   /* 双击判定已移除；留着这个空函数免得测试/调试接口报错 */
				onTap(orb, function () { HF.toggleBubbles(); });
				try {
					document.addEventListener("click", function (e) {
						try { if (HF.btn && HF.btn.contains(e.target)) { return; } HF.closeBubbles(); } catch (err) { }
					}, true);
				} catch (e) { }
				bindTip(orb, "单击：弹出 记录/重来/结束/设置；面板点【设置】泡泡打开；按住可拖动（贴边吸附）。开了「气泡常驻」时单击不再开合泡泡");
				/* 转屏 / 改窗口大小 → 泡泡方向重算 */
				try {
					if (window.addEventListener) {
						window.addEventListener("resize", function () { try { HF.relayoutBubbles(); } catch (e) { } });
						window.addEventListener("orientationchange", function () { setTimeout(function () { try { HF.relayoutBubbles(); } catch (e) { } }, 300); });
					}
				} catch (e) { }
				/* 水波颜色缓慢流动（10 次/秒，省电） */
				try {
					var wave = orb.getElementsByClassName("hf-wave")[0];
					if (HF.waveTimer) { clearInterval(HF.waveTimer); }
					var tt = 0;
					HF.waveTimer = setInterval(function () {
						try {
							if (!HF.orb || !document.documentElement.contains(HF.orb)) { clearInterval(HF.waveTimer); HF.waveTimer = null; return; }
							tt += 0.048;   /* 对齐 3.html 的 0.008/帧（60fps ≈ 0.48/秒） */
							var hue = 205 + Math.sin(tt) * 15;
							wave.style.setProperty("--wave-light", "hsl(" + (hue - 5) + "," + (90 + Math.sin(tt * 1.3) * 10) + "%," + (65 + Math.sin(tt * 0.7) * 10) + "%)");
							wave.style.setProperty("--wave-dark", "hsl(" + (hue + 10) + ",100%," + (45 + Math.sin(tt * 0.9) * 8) + "%)");
						} catch (e) { }
					}, 100);
				} catch (e) { }
				HF.updateActions();
				if (HF.open) { HF.render(); }
				/* 记住的「气泡常驻」开着 → 一进场就把泡泡摊开 */
				if (HF.cfg.bubblePin) { try { HF.openBubbles(); } catch (e) { } }
			}
			/* 泡泡展开 / 收起 */
			/* 泡泡往哪边飞：照 3.html 是「左 · 左上 · 上」（180°/135°/90°），
			   但球贴左边 / 贴上面时这三个方向就在屏幕外了，所以按剩余空间整组镜像：
			   左边放不下 → 翻到右（0°/45°/90°）；上边放不下 → 翻到下（180°/225°/270°）；都不够 → 右下。 */
			HF.bubbleVec = function () {
				var box = HF.btn;
				var vw = document.documentElement.clientWidth || window.innerWidth || 360;
				var vh = document.documentElement.clientHeight || window.innerHeight || 640;
				var size = box.offsetWidth || 46;
				var R = Math.round(size * 1.06);      /* 与 3.html 一致：球宽 × 1.06 */
				var need = R + 19 + 8;                /* 泡泡半径 19 + 8px 余量 */
				var cx = (box.offsetLeft || 0) + size / 2, cy = (box.offsetTop || 0) + size / 2;
				/* 注意符号：180° 的 cos = −1，它本身就是"往左"，
				   所以 sx = +1 才代表照 3.html 往左；镜像到右边是 −1。上边同理（sy = +1 = 往上）。 */
				var sx = (cx - need >= 0) ? 1 : -1;
				var sy = (cy - need >= 0) ? 1 : -1;
				if (sx < 0 && vw - cx < need) { sx = 1; }    /* 右边也放不下就还是照 HTML 来 */
				if (sy < 0 && vh - cy < need) { sy = 1; }
				/* 四个泡泡的固定顺序（照用户要求）：① 记录 ② 重来 ③ 停止（结束）④ 设置，
				   沿弧线依次排开：180° → 135° → 90° → 45°（左 · 左上 · 上 · 右上）。 */
				var BASE = [180, 135, 90, 45];
				var vec = function (deg) {
					var rad = deg * Math.PI / 180;
					return { dx: Math.round(sx * Math.cos(rad) * R), dy: Math.round(sy * -Math.sin(rad) * R) };
				};
				var fits = function (v) {   /* 整颗泡泡（含半径 19）都要在屏幕里 */
					var x = cx + v.dx, y = cy + v.dy;
					return (x - 19 >= 0) && (x + 19 <= vw) && (y - 19 >= 0) && (y + 19 <= vh);
				};
				var vecs = function (arr) {
					return arr.map(function (d) { return vec(d); });
				};
				var out = vecs(BASE);
				var okAll = function (vs) { for (var i = 0; i < vs.length; i++) { if (!fits(vs[i])) { return false; } } return true; };
				if (!okAll(out)) {
					var ROTS = [45, -45, 90, -90, 135, -135, 180];
					for (var i2 = 0; i2 < ROTS.length; i2++) {
						var cand = vecs(BASE.map(function (d) { return d + ROTS[i2]; }));
						if (okAll(cand)) { out = cand; break; }
					}
				}
				
				if (!okAll(out)) {
					var R2 = R + 25;
					var vec2 = function (deg) {
						var rad = deg * Math.PI / 180;
						return { dx: Math.round(sx * Math.cos(rad) * R2), dy: Math.round(sy * -Math.sin(rad) * R2) };
					};
					var BASE2 = [180, 150, 120, 90];
					for (var i3 = 0; i3 < ROTS.length; i3++) {
						var cand2 = BASE2.map(function (d) { return vec2(d + ROTS[i3]); });
						if (okAll(cand2)) { out = cand2; break; }
					}
					if (!okAll(out)) { out = BASE2.map(function (d) { return vec2(d); }); }
				}
				return out;
			};
			HF.pbTimers = [];
			HF.clearPBTimers = function () {
				try { (HF.pbTimers || []).forEach(function (o) { clearTimeout(o && o.id); }); } catch (e) { }
				HF.pbTimers = [];
			};
			HF.openBubbles = function (instant) {
				try {
					var box = HF.btn; if (!box || !HF.slots) { return; }
					HF.clearPBTimers();
					var vecs = HF.bubbleVec();
					box.classList.add("hf-open");
					HF.bubbleOpen = true;
					HF.slots.forEach(function (s, i) {
						var v = vecs[i] || { dx: 0, dy: 0 };
						var d = instant ? 0 : i * 70;
						s.slot.style.transitionDelay = d + "ms";
						s.slot.style.transform = "translate(" + v.dx + "px," + v.dy + "px)";
						s.btn.style.transitionDelay = (instant ? 0 : d + 50) + "ms";
						s.btn.style.opacity = "1";
						s.btn.style.transform = "scale(1)";
						if (instant) {
							s.btn.style.pointerEvents = "auto";
						} else {
							s.btn.style.pointerEvents = "none";
							var fn = function () { try { if (HF.bubbleOpen) { s.btn.style.pointerEvents = "auto"; } } catch (e) { } };
							HF.pbTimers.push({ id: setTimeout(fn, d + 50 + 360), fn: fn });
						}
					});
				} catch (e) { }
			};
			HF.closeBubbles = function (force) {
				try {
					if (HF.cfg && HF.cfg.bubblePin && !force) { return; }   /* 常驻：不收 */
					if (!HF.btn || !HF.slots) { return; }
					HF.clearPBTimers();   /* 收起时把"到点开点击"的定时器全部撤掉 */
					HF.btn.classList.remove("hf-open");
					HF.bubbleOpen = false;
					HF.slots.forEach(function (s, i) {
						var d = (HF.slots.length - 1 - i) * 55;
						s.slot.style.transitionDelay = d + "ms";
						s.slot.style.transform = "translate(0,0)";
						s.btn.style.transitionDelay = d + "ms";
						s.btn.style.pointerEvents = "none";   /* 收起立即不可点 */
						s.btn.style.opacity = "0";
						s.btn.style.transform = "scale(.3)";
					});
				} catch (e) { }
			};
			HF.toggleBubbles = function () {
				if (HF.cfg && HF.cfg.bubblePin) { return; }   /* 常驻：单击球不再开合泡泡 */
				if (HF.bubbleOpen) { HF.closeBubbles(); } else { HF.openBubbles(); }
			};
			/* 球被拖走 / 转屏之后重算方向（常驻或已展开时；instant 不再错峰，避免又飞一次） */
			HF.relayoutBubbles = function () {
				try { if (HF.bubbleOpen || (HF.cfg && HF.cfg.bubblePin)) { HF.openBubbles(true); } } catch (e) { }
			};


			function el(tag, cls, parent, html) {
				var n = document.createElement(tag || 'div');
				var list = String(cls || '').replace(/^\./, '').split(/\s+/);
				var keep = [];
				for (var i = 0; i < list.length; i++) {
					if (!list[i]) { continue; }
					keep.push(list[i]);
					if (HF_STYLE[list[i]]) { sty(n, HF_STYLE[list[i]]); }
				}
				if (keep.length) { n.className = keep.join(' '); }
				if (parent) { parent.appendChild(n); }
				if (html != null) { n.innerHTML = html; }
				return n;
			}
			function pbtn(parent, text, fn, cls) {
				var b = el('div', cls || 'hf-btnrow', parent);
				b.innerHTML = text;
				onTap(b, function (e) { if (e && e.stopPropagation) { e.stopPropagation(); } fn(); });
				return b;
			}
			function btnRow(parent, list) {
				var row = el('div', 'hf-row', parent);
				list.forEach(function (it) {
					var b = pbtn(row, it[1], it[0], it[2]);
					if (it[2]) { b.classList.add(it[2]); }
				});
				return row;
			}
			function buildPanel() {
				if (HF.panel) { return; }
				injectCSS();
				var p = el('div', 'hf-panel');
				restorePos(p, 'hf_panel_pos');
				try { layer().appendChild(p); } catch (e) { }
				HF.panel = p;
				var head = el('div', 'hf-head', p, '<span class="hf-handle">⠿</span><span class="hf-title">复盘工具</span><span class="hf-close">✕</span>');
				dragify(p, head, 'hf_panel_pos');
				onTap(head.lastChild, function () { HF.toggle(false); });
				bindTip(head.lastChild, '关闭面板（记录/回到起点后会自动收起，不用点这里）');
				bindTip(head, '按住这里可以把面板拖到任意位置');
				var tabs = el('div', 'hf-tabs', p);
				[['start', '起点'], ['rec', '记录'], ['hand', '手牌']].forEach(function (t) {
					var n = el('div', 'hf-tab', tabs, t[1]);
					n.dataset.tab = t[0];
					onTap(n, function () { HF.setTab(t[0]); });
					bindTip(n, t[0] === 'start' ? '起点：快照信息与开关' : t[0] === 'rec' ? '记录：多条尝试的对比表' : '手牌：摆出想试的手牌');
				});
				el('div', 'hf-body', p);
			}

			HF.setTab = function (t) {
				HF.tab = t;
				if (!HF.panel) return;
				var tabs = HF.panel.getElementsByClassName('hf-tab');
				for (var i = 0; i < tabs.length; i++) {
					var on = (tabs[i].dataset.tab === t);
					if (on) { tabs[i].classList.add('hf-sel'); } else { tabs[i].classList.remove('hf-sel'); }
					try { tabs[i].style.cssText = ''; sty(tabs[i], HF_STYLE[on ? 'hf-tab-on' : 'hf-tab']); } catch (e) { }
				}
				HF.render();
			};
			HF.toggle = function (force) {
				var open = (force === undefined) ? !HF.open : !!force;
				HF.open = open;
				if (open) {
					buildPanel();
					HF.panel.style.display = 'flex';
					try { ensureOnScreen(HF.panel); } catch (e) { }
					HF.setTab(HF.tab);   /* 打开时同步页签高亮与内容，避免内容切了高亮没切 */
					try { HF.closeBubbles(); HF.updateActions(); } catch (e) { }   /* 面板打开：收起泡泡 */
					try {
							if (HF.panel.getBoundingClientRect) {
							var rr = HF.panel.getBoundingClientRect();
							if (!rr || rr.width < 40 || rr.height < 20) { HF.diag(); }
						}
					} catch (e) { }
					toast('复盘面板已打开 ' + rectText(HF.panel));
					if (HF.timer) clearInterval(HF.timer);
					HF.timer = setInterval(function () {
						if (HF.open && (HF.tab === 'stat' || HF.tab === 'start')) { HF.render(); }
					}, 800);
				} else {
					if (HF.panel) { HF.panel.style.display = 'none'; }
				try { HF.updateActions(); } catch (e) { }   /* 面板关闭：恢复界面按钮 */
					if (HF.timer) { clearInterval(HF.timer); HF.timer = null; }
				}
				if (HF.btn) {
					try {
						/* 只改颜色，绝不 style.cssText=''：那样会把拖拽后的 left/top 一起抹掉，按钮就弹回原位 */
						/* 高亮不再用红底：只切 hf-on，颜色全交给 Cupertino 样式表 */
						HF.btn.style.background = '';
						HF.btn.style.color = '';
						HF.btn.style.borderColor = '';
					} catch (e) { }
				}
			};

			/* ---- 各页渲染 ---- */
			HF.render = function () {
				if (!HF.panel) return;
				var body = HF.panel.getElementsByClassName('hf-body')[0];
				if (!body) return;
				var t = HF.tab;
				try {
					var maxH = Math.max(360, (window.innerHeight || 640) * 0.96 - 118);
					HF.bodyH = Math.round(maxH);
					body.style.height = HF.bodyH + 'px';
				} catch (e) { }
				if (t === 'start') { renderStart(body); }
				else if (t === 'hand') { renderHand(body); }
				else { renderRec(body); }
			};

						function buildOverAsk(snap, cb) {
				try { if (HF.overAsk) { HF.overAsk.remove(); HF.overAsk = null; } } catch (e) { }
				var box = el('div', 'hf-ask', layer());
				HF.overAsk = box;
				var mine = null;
				try { snap.players.forEach(function (r) { if (game.me && r.seat === SEAT(game.me)) { mine = r; } }); } catch (e) { }
				var html = '<div class="hf-sec"' + S.sec + '>对局即将结束</div>';
				html += '<div' + S.kv + '>要回到起点继续复盘吗？<br>（' + (HF.start ? '手动起点' : '自动快照') + '：' + (snap.label || '') + '，牌堆 ' + (snap.pile ? snap.pile.length : '?') + ' 张）';
				if (mine) { html += '<br>那时你：' + mine.hp + '/' + mine.maxHp + ' 体力，手牌 ' + (mine.hand || []).map(cardName).join(' '); }
				html += '</div>';
				box.innerHTML = html;
				var row = el('div', 'hf-askrow', box);
				var close = function () { try { box.remove(); } catch (e) { } HF.overAsk = null; };
				pbtn(row, '保存记录并回溯', function () { close(); cb(true, true); });
				pbtn(row, '就这么结束', function () { close(); cb(false); });
			}
			function tipOf(key) {
				var m = {
					pileBar: '右上角那一行牌堆分类计数（己基/敌基/己锦/敌锦/锦其/装备/废牌）',
					showHand: '拆顺明牌：看对方手牌时按真实牌面列出（默认是牌背且顺序随机，回溯后没法牵同一张）',
					askOver: '对局结束时的提示框：开着就先弹窗问「保存记录并回溯 / 就这么结束」；关掉就直接正常结算，不弹任何浮窗',
					autoName: '默认命名：开着时存记录直接用 ① ② ③ 这种默认名，【重来】【结束】都不会再弹起名框；关掉就每次问你一句（点取消＝这条不存）',
					autoClose: '点完记录/回到起点自动收起面板，不用再点右上角的叉',
					autoSnap: '每个自己的回合开始时自动留一份快照（不覆盖手动起点）',
					bubblePin: '气泡常驻：这几个泡泡一直贴在屏幕上不收起来（点别处、点完泡泡都不收），单击球也不再开合它们；面板改点【设置】泡泡打开。球拖到屏幕边上时泡泡会自动换方向，不会飞出屏幕'
				};
				return m[key] || key;
			}
			function renderStart(body) {
				var s = HF.start;
				var html = '';
				html += '<div class="hf-row" id="hf-start-row"' + S.row + '></div>';
				html += '<div class="hf-row" id="hf-cfg-row"' + S.row + '></div>';
				if (s) {
					var mine = null;
					s.players.forEach(function (r) { if (game.me && r.seat === SEAT(game.me)) { mine = r; } });
					html += '<div class="hf-sec"' + S.sec + '>起点</div><div class="hf-kv"' + S.kv + '>' +
						'记录于 ' + (s.time ? new Date(s.time).toTimeString().slice(0, 8) : nowText()) + '　' + (s.label || '') + '\n';
					s.players.forEach(function (r) {
						html += PN(bySeat(r.seat)) + '：' + r.hp + '/' + r.maxHp + (r.linked ? ' [铁索]' : '') + (r.turned ? ' [翻面]' : '') + '\n';
					});
					if (mine) { html += '起点手牌：' + mine.hand.map(cardName).join(' ') + '\n'; }
					html += '牌堆：剩 ' + s.pile.length + ' 张　弃牌堆：' + s.discard.length + ' 张</div>';
				} else {
					html += '<div class="hf-dim"' + S.dim + '>还没有手动记录起点（回到起点时会用自动快照）。点【记录起点】把现在这一刻存下来。</div>';
				}
				if (HF.autoStart) {
					html += '<div class="hf-tip"' + S.tip + '>自动快照：' + (HF.autoTime || '') + '（' + (HF.autoStart.label || '') + '，牌堆 ' + HF.autoStart.pile.length + ' 张）——每个回合开始时自动更新，对局要结束时会拿它问你。</div>';
				}
				html += '<div class="hf-tip"' + S.tip + '>【记录】【重来】【结束】三个按钮在界面左下角（自己的出牌阶段显示重来/结束）。</div>';
				body.innerHTML = html;
				var srow = document.getElementById('hf-start-row');
				var crow = document.getElementById('hf-cfg-row');
				if (!srow) { return; }
				/* 记录 / 回到起点：做完自动收起面板，不用再点右上角的叉 */
				var doRecord = function () { HF.recordStart(); };
				var doRestore = function () { HF.backToStart(); };
				btnRow(srow, [
					[function () { HF.start = null; HF.render(); toast('已清除手动起点'); }, '清除起点']
				]);
				var sb = srow.getElementsByClassName('hf-btnrow');
				bindTip(sb[0], '丢掉手动起点（自动快照还在）。记录/重来/结束 都在界面左下角的按钮上');
				if (crow) {
					var idx = 0;
					var mk = function (key, label) {
						var b = pbtn(crow, label + (HF.cfg[key] ? "：开" : "：关"), function () {
							setCfg(key, !HF.cfg[key]);
							HF.render();
						}, HF.cfg[key] ? "hf-btnrow hf-on" : "hf-btnrow");
						bindTip(b, tipOf(key));
						b.style.flex = '0 0 auto'; b.style.padding = '5px 7px'; b.style.margin = '0 3px 3px 0'; b.style.fontSize = '12px';
						return b;
					};
					mk('pileBar', '牌堆分类');
					mk('showHand', '拆顺明牌');
					mk('autoSnap', '自动快照');
					mk('bubblePin', '气泡常驻');
					/* 对局结束时的提示框：关掉就直接结算，不再弹浮窗 */
					mk('askOver', '结束提示');
					/* 默认命名：开着就不用每次给记录起名了 */
					mk('autoName', '默认命名');
				}
			}

						function renderHand(body) {
				var p = game.me;
				var html = '<div class="hf-row" id="hf-hrow"' + S.row + '></div>';
				html += '<div class="hf-sec"' + S.sec + '>加牌方式</div>';
				html += '<div class="hf-row" id="hf-mrow"' + S.row + '></div>';
				html += '<div class="hf-sec"' + S.sec + '>我的手牌（点一下＝丢弃这张）</div>';
				html += '<div class="hf-cards" id="hf-cards"' + S.cards + '></div>';
				html += '<div class="hf-tip"' + S.tip + '>【虚拟牌】不碰牌堆，用完就消失；【从牌堆取】会真的从牌堆顶往下找第一张，牌堆因此变少（顺序也变），做「摸到什么牌」的复盘要用这个。</div>';
				body.innerHTML = html;
				var row = body.getElementsByClassName('hf-row')[0];
				var mrow = document.getElementById('hf-mrow');
				var box = body.getElementsByClassName('hf-cards')[0];
				if (!row || !box) { return; }
				/* 模式切换：当前模式按钮高亮（金色实心），一眼能看出选了哪个 */
				if (mrow) {
					var mb1 = pbtn(mrow, (HF.cfg.addMode === 'virtual' ? '● ' : '') + '虚拟牌（不进牌堆）', function () { setCfg('addMode', 'virtual'); HF.render(); }, HF.cfg.addMode === 'virtual' ? 'hf-btnrow hf-on' : 'hf-btnrow');
					bindTip(mb1, '虚拟牌：造一张牌直接进手牌，牌堆张数与顺序都不变（用完就消失）');
					var mb2 = pbtn(mrow, (HF.cfg.addMode === 'pile' ? '● ' : '') + '从牌堆取（定向检索）', function () { setCfg('addMode', 'pile'); HF.render(); }, HF.cfg.addMode === 'pile' ? 'hf-btnrow hf-on' : 'hf-btnrow');
					bindTip(mb2, '从牌堆顶往下找第一张同名（可加花色点数），牌堆会真的变少——复盘摸牌必须用这个');
				}
				btnRow(row, [
					[function () {
						var inp = HF.panel.getElementsByClassName('hf-cardinput')[0];
						var name = inp ? (inp.value || '').trim() : '';
						if (!name) { toast('先输入牌名'); return; }
						addCardByName(name, HF.cfg.addMode);
					}, HF.cfg.addMode === 'pile' ? '从牌堆取这张' : '加入手牌']
				]);
				var jb = row.getElementsByClassName('hf-btnrow')[0];
				bindTip(jb, '按上面的方式加牌：中文名、英文 id 或「杀 红桃 5」都行');
				var inp = el('div', 'hf-inp', row);
				try {
					var real = document.createElement('input');
					real.className = 'hf-cardinput';
					real.setAttribute('placeholder', '牌名（中文或 id）：杀 / 火杀 / 闪 / 桃 / 无中生有 / 铁索连环 / sha');
					sty(real, HF_STYLE['hf-input']);
					inp.appendChild(real);
				} catch (e) { inp.innerHTML = '<input class="hf-cardinput" style="width:100%;box-sizing:border-box;background:rgba(118,118,128,.24);color:#fff;border:none;border-radius:10px;padding:11px 12px;outline:none;" placeholder="牌名">'; }
				var quick = el('div', 'hf-row', body);
				var QUICK_CARDS = ["sha","huosha","shan","tao","jiu","guohe","shunshou","wuzhong","tiesuo","huogong","juedou","nanman","wanjian","taoyuan","wugu","wuxie","zhuge","bagua","chitu","guanshifu"];
				QUICK_CARDS.forEach(function (id) {
					if (!lib.card[id]) { return; }
					var qb = pbtn(quick, T(id), function () { addCardByName(id, HF.cfg.addMode); }, 'hf-btnrow');
					bindTip(qb, '把「' + T(id) + '」按当前方式加进手牌');
					qb.style.flex = '0 0 auto'; qb.style.padding = '5px 7px'; qb.style.margin = '0 3px 3px 0'; qb.style.fontSize = '12px';
				});
				var extra = el('div', 'hf-row', body);
				var eb1 = pbtn(extra, '摸1张', function () { try { game.me.draw(1); } catch (e) { } HF.render(); refreshPileBar(); });
				bindTip(eb1, '摸 1 张（走本体的摸牌流程，牌堆会变少）');
				var eb2 = pbtn(extra, '清空手牌', function () { toDiscard(game.me.getCards('h')); HF.render(); toast('手牌已清空'); });
				bindTip(eb2, '把手上的牌全部丢进弃牌堆');
				var eb3 = pbtn(extra, '当前手牌→起点手牌', function () {
					if (!HF.start) { toast('先记录起点'); return; }
					var rec = null;
					HF.start.players.forEach(function (r) { if (game.me && r.seat === SEAT(game.me)) { rec = r; } });
					if (rec) {
						/* 手牌现在按"左右手容器"还原，所以两个容器都要一起更新 */
						rec.hand = game.me.getCards('h').slice(0);
						rec.hand1 = nodeList(game.me.node.handcards1);
						rec.hand2 = nodeList(game.me.node.handcards2);
						toast('起点手牌已更新');
					}
				});
				bindTip(eb3, '把现在的手牌直接写进起点快照（不用重新记录整个起点）');
				if (!p) { box.innerHTML = '<span class="hf-dim"' + S.dim + '>还没进入对局</span>'; return; }
				var hs = p.getCards('h');
				if (!hs.length) { box.innerHTML = '<span class="hf-dim"' + S.dim + '>（空）</span>'; return; }
				hs.forEach(function (c) {
					var n = el('div', 'hf-card', box);
					n.innerHTML = cardName(c);
					onTap(n, function () { toDiscard([c]); HF.render(); });
				});
			}
						/* 本体的牌 id 是英文（sha / wuzhong / tiesuo…），中文必须先翻译过来 */
			var SUIT_WORD = { '黑桃': 'spade', '红桃': 'heart', '梅花': 'club', '方块': 'diamond', 'spade': 'spade', 'heart': 'heart', 'club': 'club', 'diamond': 'diamond' };
			var NATURE_WORD = { '火': 'fire', '雷': 'thunder', '冰': 'ice', 'fire': 'fire', 'thunder': 'thunder', 'ice': 'ice' };
			var _cardKeyMap = null;
			function cardKeyMap() {
				if (_cardKeyMap) { return _cardKeyMap; }
				var m = {};
				try {
					for (var k in lib.card) {
						if (!Object.prototype.hasOwnProperty.call(lib.card, k)) { continue; }
						if (!m[k]) { m[k] = k; }
						var t1 = null;
						try { t1 = lib.translate ? lib.translate[k] : null; } catch (e) { }
						if (t1) {
							t1 = String(t1);
							if (!m[t1]) { m[t1] = k; }
							var base = t1.replace(/[（(].*$/, '').replace(/[\[【].*$/, '').replace(/杀$/, 'sha');
							if (base && !m[base]) { m[base] = k; }
						}
						try { var t2 = T(k); if (t2 && !m[String(t2)]) { m[String(t2)] = k; } } catch (e) { }
					}
				} catch (e) { }
				/* 常见别名 */
				var alias = { '杀': 'sha', '闪': 'shan', '桃': 'tao', '酒': 'jiu', '火攻': 'huogong', '铁索连环': 'tiesuo' };
				for (var a in alias) { if (!m[a]) { m[a] = alias[a]; } }
				return (_cardKeyMap = m);
			}
			function resolveCardName(word) {
				if (!word) { return null; }
				word = String(word).trim();
				if (!word) { return null; }
				if (lib.card[word]) { return word; }
				var m = cardKeyMap();
				if (m[word]) { return m[word]; }
				return null;
			}
			/* 支持：杀 / 火杀 / 无中生有 / sha / 杀 红桃 5 / 红桃5 */
			function parseCardInput(text) {
				var out = { name: null, suit: "", number: 0, nature: "" };
				var parts = String(text == null ? "" : text).replace(/[,，、\s]+/g, " ").trim().split(" ");
				var list = [];
				for (var i = 0; i < parts.length; i++) { if (parts[i]) { list.push(parts[i]); } }
				if (!list.length) { return out; }
				var word = list.shift();
				out.name = resolveCardName(word);
				if (!out.name && word.length > 1 && NATURE_WORD[word.charAt(0)]) {
					var k = resolveCardName(word.slice(1));
					if (k) { out.name = k; out.nature = NATURE_WORD[word.charAt(0)]; }
				}
				if (!out.name) { return out; }
				for (var j = 0; j < list.length; j++) {
					var p2 = list[j];
					var mm = p2.match(/^(黑桃|红桃|梅花|方块)(\d{1,2})$/);
					if (mm) { out.suit = SUIT_WORD[mm[1]]; out.number = parseInt(mm[2], 10); continue; }
					if (SUIT_WORD[p2]) { out.suit = SUIT_WORD[p2]; continue; }
					if (NATURE_WORD[p2]) { out.nature = NATURE_WORD[p2]; continue; }
					var n2 = parseInt(p2, 10);
					if (!isNaN(n2) && n2 >= 1 && n2 <= 13) { out.number = n2; }
				}
				return out;
			}
						/* 从牌堆顶往下一张张找指定牌（"定向检索"），找到就拿到手里；
			   牌堆没有就没有了 —— 和虚拟牌不同，这会真的影响牌堆顺序与张数 */
			function takeFromPile(info) {
				try {
					var pile = ui.cardPile;
					if (!pile) { return null; }
					var found = null;
					for (var i = 0; i < pile.childNodes.length; i++) {
						var c = pile.childNodes[i];
						if (!c || String(c.name) !== info.name) { continue; }
						if (info.suit && c.suit !== info.suit) { continue; }
						if (info.number && c.number !== info.number) { continue; }
						found = c;
						break;
					}
					return found;
				} catch (e) { return null; }
			}
			function addCardByName(name, mode) {
				var info = parseCardInput(name);
				if (!info.name) {
					toast("找不到「" + String(name == null ? "" : name).trim() + "」：可写 杀 / 闪 / 桃 / 火杀 / 无中生有 / 铁索连环，也可写 id（sha / wuzhong）");
					return;
				}
				/* 模式二：从牌堆里检索（牌堆上没有就真的没有） */
				if (mode === "pile") {
					try {
						var got = takeFromPile(info);
						if (!got) {
							toast("牌堆里已经没有「" + T(info.name) + "」了（剩余 " + ui.cardPile.childNodes.length + " 张）");
							return;
						}
						prepCard(got);
						giveCards(game.me, [got]);
						try { game.updateRoundNumber(); } catch (e) { }
						HF.render();
						refreshPileBar();
						toast("从牌堆取出：" + cardName(got) + "（牌堆剩 " + ui.cardPile.childNodes.length + " 张）");
					} catch (e) {
						toast("从牌堆取牌失败：" + info.name);
					}
					return;
				}
				/* 模式一（默认）：虚拟牌 —— 不碰牌堆，用完即消失 */
				try {
										/* 虚拟牌：无花色（本体约定 suit='none'，显示 ◈）无点数；用户明确写了花色点数才用 */
					var card = game.createCard(info.name, info.suit || "none", (info.number === 0 ? 0 : (info.number || 0)), info.nature || undefined);
					prepCard(card);
					giveCards(game.me, [card]);
					HF.render();
					toast("已加入（虚拟牌）：" + cardName(card));
				} catch (e) {
					toast("创建失败：" + info.name);
				}
			}

			function renderStat(body) {
				var st = HF.stat;
				var html = '';
				var mine = SEAT(game.me);
				var lines = [];
				var sd = sideDamage(st);
				lines.push('伤害总计：' + st.total + '　（手牌 ' + st.card + '｜技能 ' + st.skill + '）' + (st.nigu ? '　逆固加成 ' + st.nigu : ''));
				lines.push('对敌 ' + fmt1(sd.enemyDmg) + '｜对友 ' + fmt1(sd.allyDmg) + '｜身份未明 ' + fmt1(sd.unknownDmg) + '｜自己承受 ' + fmt1(sd.selfTaken));
				lines.push('击杀 ' + (st.kill || 0) + (st.killList && st.killList.length ? '（' + st.killList.join('、') + '）' : ''));
				var sumTgt = 0, sumSrc = 0;
				for (var kk in st.tgt) { sumTgt += st.tgt[kk].n; }
				for (var kk2 in st.src) { sumSrc += st.src[kk2]; }
				lines.push('合计校验：总计 ' + st.total + '　按目标 ' + fmt1(sumTgt) + '　按来源 ' + fmt1(sumSrc) + '　' +
					(Math.abs(sumTgt - st.total) < 0.001 && Math.abs(sumSrc - st.total) < 0.001 ? '✓ 一致' : '⚠ 不一致'));
				if (Object.keys(st.tgt).length) {
					var arr = [];
					var sideNames = {};
					allP().forEach(function (pp) { sideNames[PN(pp)] = pp; });
					for (var k in st.tgt) {
						var o = st.tgt[k];
						var natTxt = "";
						for (var nn in o.nat) { if (nn !== 'normal') { natTxt += T(nn) + o.nat[nn] + ' '; } }
						var nmTxt = sideNames[k] ? sideSpan(sideNames[k]) : k;
						arr.push(nmTxt + ' ' + o.n + (natTxt ? '(' + natTxt.trim() + ')' : ''));
					}
					lines.push('按目标：' + arr.join('　'));
				}
				var srcs = [];
				for (var s in st.src) { srcs.push(s + ' ' + st.src[s]); }
				if (srcs.length) { lines.push('按来源：' + srcs.join('　')); }
				lines.push('过牌：获得 ' + st.gain + '　失去 ' + loseTxt(st.lose) + '　弃置 ' + loseTxt(st.discard));
				var hpTxt = [];
				allP().forEach(function (p) {
					var a = st.hp0[SEAT(p)], b = st.hpNow[SEAT(p)];
					hpTxt.push(rel(p) + ' ' + (a === undefined ? '?' : a) + '→' + (b === undefined ? p.hp : b));
				});
				lines.push('体力：' + hpTxt.join('　'));
				html += '<div class="hf-kv"' + S.kv + '>' + lines.join('\n') + '</div>';
				html += '<div class="hf-sec"' + S.sec + '>出牌顺序（排序）</div><div class="hf-kv"' + S.kv + '>';
				if (!st.seq.length) { html += '<span class="hf-dim"' + S.dim + '>（还没有动作）</span>'; }
				else {
					st.seq.forEach(function (e) {
						html += seqHTML(e) + '\n';
					});
				}
				html += '</div>';
				html += '<div class="hf-tip"' + S.tip + '>想比较两次操作：先【记录起点】，试完后点【结束并保存记录】命名存档，然后【回到起点】再试另一套排序。</div>';
				body.innerHTML = html;
				var row = el('div', 'hf-row', body);
				var rb1 = pbtn(row, '重新开始统计', function () { HF.stat = newStat(); HF.seqId = 0; HF.render(); toast('统计已重置'); });
				bindTip(rb1, '把统计清零重新记（局面不动）');
				var rb2 = pbtn(row, '保存记录', function () { saveRecord(); });
				bindTip(rb2, '把这次的伤害/过牌/顺序存成一条记录（存完自动收起面板，想连做几轮就用旁边那个）');
				var rb3 = pbtn(row, '保存并回到起点', function () {
					var snap = HF.usableStart();
					if (!snap) { HF.noStartTip(); return; }
					saveRecord();
					restore(snap);
					toast('已保存记录并回到起点，可以再来一轮');
					if (HF.cfg.autoClose) { HF.toggle(false); } else { HF.render(); }
				});
				bindTip(rb3, '先存一条记录，然后立刻回到起点重新试——连着做几轮排序实验就用这个；没有起点时会提示先记录起点，不会动牌');
				body.insertBefore(row, body.firstChild);
			}

			function saveRecord() {
				var st = HF.stat;
			var CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
				var def = HF.records.length < CIRCLED.length ? CIRCLED.charAt(HF.records.length) : ("第" + (HF.records.length + 1) + "次");
				var name = def;
				/* 开了「默认命名」→ 不弹框，直接用默认名（① ② ③…），重来 / 结束 都不会再被打断 */
				if (!HF.cfg.autoName) {
					try {
						var r = window.prompt('给这次尝试起个名字（方便区分排序）', def);
						/* 用户点了取消（null）→ 不保存，返回 false，让调用方决定后续（例如不跳页） */
						if (r === null || r === undefined) { return false; }
						if (String(r).trim()) { name = String(r).trim(); }
					} catch (e) { /* prompt 不可用时按默认名继续保存 */ }
				}
				name = name.slice(0, 20);
				HF.records.push({
					name: name, time: nowText(), label: phaseText(),
					total: st.total, card: st.card, skill: st.skill, nigu: st.nigu,
					tgt: JSON.parse(JSON.stringify(st.tgt)),
					/* 表格要展示"自己剩余手牌/血量" */
					myHand: (game.me && game.me.countCards) ? game.me.countCards("h") : 0,
					myHp: st.hpNow[SEAT(game.me)],
					myMaxHp: game.me ? game.me.maxHp : 0,
					side: sideDamage(st),
					kill: st.kill || 0, killList: (st.killList || []).slice(0),
					src: JSON.parse(JSON.stringify(st.src)),
					gain: st.gain, lose: st.lose, discard: st.discard,
					hp0: JSON.parse(JSON.stringify(st.hp0)), hpNow: JSON.parse(JSON.stringify(st.hpNow)),
					seq: st.seq.map(function (e) { return seqHTML(e); }),
					dmgText: (st.total + '（手牌' + st.card + '/技能' + st.skill + '）')
				});
				toast('已保存：' + name + (HF.records.length > 1 ? '（共 ' + HF.records.length + ' 条，可对比）' : ''));
				/* 不跳页：需要看对比时自己切「记录」页，避免打断连续实验 */
				HF.recCount = -1;
				if (HF.tab === "rec") { HF.render(); }
				return true;  
			}

															/* 对比表：真 <table> + table-layout:fixed —— 列永远对齐、每行同高，几条记录都不会错乱 */
						function cmpTable(recs) {
				if (!Array.isArray(recs)) { recs = [recs]; }
				recs = recs.filter(function (r) { return !!r; });
				if (!recs.length) { return ''; }
				var h = '<table class="hf-tb"><colgroup><col class="hf-tbc" />';
				forEach(recs, function () { h += '<col />'; });
				h += '</colgroup><tr><th>项目</th>';
				forEach(recs, function (r) { h += '<th>' + r.name + '</th>'; });
				h += '</tr>';
				var row = function (label, fn, sub) {
					var s = '<tr' + (sub ? ' class="hf-sub"' : '') + '><td class="hf-tk">' + label + '</td>';
					forEach(recs, function (r) { s += '<td>' + fn(r) + '</td>'; });
					return s + '</tr>';
				};
				h += row('击杀', function (r) { return r.kill || 0; });
				h += row('伤害', function (r) { return r.total; });
				var others = {};
				forEach(recs, function (r) {
					for (var k in r.tgt) {
						var pp = playerByName(k);
						if (pp && pp !== game.me) { others[k] = 1; }
					}
				});
				for (var nm in others) {
					h += row(nm, (function (name) { return function (r) { return r.tgt[name] ? fmt1(r.tgt[name].n) : 0; }; })(nm), true);
				}
				h += row('当前状态', function (r) { return (r.myHp === undefined ? '?' : r.myHp) + '血' + (r.myHand === undefined ? '?' : r.myHand) + '牌'; });
				h += row('过牌量', function (r) { return r.gain === undefined ? '-' : r.gain; });
				h += '</table>';
				h += '<div class="hf-sec"' + S.sec + '>出牌顺序</div>';
				forEach(recs, function (r) {
					h += '<div class="hf-chain"' + S.chain + '><b>' + r.name + '</b> ' + (r.seq && r.seq.length ? r.seq.join(' ') : '（无动作）') + '</div>';
				});
				return h;
			}

			var compareHTML = cmpTable;



												function renderRec(body) {
				/* 表格 / 出牌顺序 / 按钮行 全在同一个容器里（同级、同一个滚动区） */
				var html = '<div id="hf-cmpbox" class="hf-cmp"' + S.cmp + '></div>';
				if (!HF.records.length) {
					html += '<div class="hf-dim"' + S.dim + '>还没有记录。统计页点【保存记录】就会存一条。</div>';
				}
				body.innerHTML = html;
				/* 默认全选：所有记录都进对比表（已删掉 ①②③ 多选列表与「全选」按钮） */
				var box = document.getElementById("hf-cmpbox");
				if (box) {
					/* 按钮行直接接在出牌顺序后面，与表格同一层 */
					box.innerHTML = (HF.records.length ? compareHTML(HF.records) : '') +
						'<div class="hf-row" id="hf-rrow"' + S.row + '></div>';
				}
				var row = body.getElementsByClassName('hf-row')[0] || box;
				if (!row) { return; }
				var bCopy = pbtn(row, '复制文本', function () { copyText(recordsText()); });
				bindTip(bCopy, '把全部记录复制成文本，方便粘贴到别处');
				var bClr = pbtn(row, '清空记录', function () { HF.records = []; renderRec(body); });
				bindTip(bClr, '删掉所有已保存的记录（不可恢复）');
			}


			function pad(s, n) {
				s = String(s);
				var w = 0;
				for (var i = 0; i < s.length; i++) { w += (s.charCodeAt(i) > 255 ? 2 : 1); }
				while (w < n) { s += ' '; w++; }
				return s;
			}
			function stripTags(s) {
				try { return String(s || '').replace(/<[^>]*>/g, ''); } catch (e) { return String(s || ''); }
			}
			function compareText(a, b) {
				var L = [];
				L.push(pad('项目', 14) + pad(a.name, 14) + b.name);
				L.push(pad('时间', 14) + pad(a.time, 14) + b.time);
				L.push(pad('伤害总计', 14) + pad(a.total, 14) + b.total);
				L.push(pad('　手牌伤害', 14) + pad(a.card, 14) + b.card);
				L.push(pad('　技能伤害', 14) + pad(a.skill, 14) + b.skill);
				L.push(pad('　逆固加成', 14) + pad(a.nigu || 0, 14) + (b.nigu || 0));
				L.push(pad('获得/失去', 14) + pad(a.gain + '/' + a.lose, 14) + (b.gain + '/' + b.lose));
				L.push(pad('弃置', 14) + pad(a.discard, 14) + b.discard);
				var tg = {};
				for (var k in a.tgt) { tg[k] = 1; }
				for (var k2 in b.tgt) { tg[k2] = 1; }
				for (var k3 in tg) {
					L.push(pad('对 ' + k3, 14) + pad((a.tgt[k3] ? a.tgt[k3].n : 0), 14) + (b.tgt[k3] ? b.tgt[k3].n : 0));
				}
				L.push('');
				L.push('出牌顺序对比：');
				var n = Math.max(a.seq.length, b.seq.length);
				for (var i = 0; i < n; i++) {
					L.push(pad(stripTags(a.seq[i] || ''), 24) + stripTags(b.seq[i] || ''));
				}
				return L.join('\n');
			}
			function recordsOneText(r) {
				return '== ' + r.name + ' ' + r.time + ' ' + (r.label || '') + '\n' +
					'伤害 ' + r.total + '(手牌' + r.card + '/技能' + r.skill + (r.nigu ? '/逆固' + r.nigu : '') + ') 获得' + r.gain + ' 失去' + r.lose + ' 弃置' + r.discard + '\n' +
					stripTags(r.seq.join(' '));
			}
			function recordsText() {
				var L = [];
				HF.records.forEach(function (r) {
					L.push('== ' + r.name + ' ' + r.time + ' ' + (r.label || ''));
					L.push('伤害 ' + r.total + '(手牌' + r.card + '/技能' + r.skill + (r.nigu ? '/逆固' + r.nigu : '') + ') 获得' + r.gain + ' 失去' + r.lose + ' 弃置' + r.discard);
					L.push(stripTags(r.seq.join(' ')));
					L.push('');
				});
				return L.join('\n');
			}
			function copyText(txt) {
				var ok = false;
				try {
					var ta = document.createElement('textarea');
					ta.value = txt;
					document.body.appendChild(ta);
					ta.select();
					ok = document.execCommand('copy');
					ta.remove();
				} catch (e) { }
				try {
					if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(txt); ok = true; }
				} catch (e) { }
				var box = document.getElementById('hf-cmpbox');
				if (box) { box.innerHTML = (ok ? '（已复制到剪贴板，若粘不出来就手动全选下面的文本）\n\n' : '（复制失败，请手动全选下面文本）\n\n') + txt; }
				else { toast(ok ? '已复制' : '复制失败'); }
			}
			function toast(msg) {
				try {
					if (window.skinSwitchMessage && skinSwitchMessage.show) {
						skinSwitchMessage.show({ type: 'success', text: msg, duration: 1200, closeable: false });
						return;
					}
				} catch (e) { }
				try { game.log('<span style="color:#0A84FF">[复盘]</span> ' + msg); } catch (e) { }
			}

			/* ================= 6. 启动 ================= */
			var boot = function () {
				if (_status.video || _status.connectMode) return;
				if (!HF.stat || !Object.keys(HF.stat.hp0 || {}).length) { HF.stat = newStat(); HF.seqId = 0; }
				buildButton();
				showPileBar(!!HF.cfg.pileBar);
				applyHandTag();
				installOverHook();
				/* 兜底快照：只在"真的攥着牌"时才留 —— 启动时还没发牌，留一份空快照会让「重来」把牌清空。	 真正的自动快照在第一个出牌阶段由 autoSnapshot() 生成。 */
				if (!HF.autoStart) {
					try {
						var bs = snapshot();
						if (snapHasCards(bs)) { HF.autoStart = bs; HF.autoTime = nowText(); }
						else { HF.log('启动快照跳过：还没发牌（自己手牌为空），等出牌阶段再自动存'); }
					} catch (e) { }
				}
			};
			if (lib.arenaReady && lib.arenaReady.push) { lib.arenaReady.push(boot); }
			else { setTimeout(boot, 1500); }

			HF.reveal = function () {   /* 手动重开：window.hfTool.reveal()  （会清掉记错的位置） */
				try {
					localStorage.removeItem('hf_btn_pos');
					localStorage.removeItem('hf_panel_pos');
					localStorage.removeItem('hf_pilebar_pos');
				} catch (e) { }
				try { if (HF.pileBar) { HF.pileBar.remove(); HF.pileBar = null; } } catch (e) { }
				try { if (HF.overAsk) { HF.overAsk.remove(); HF.overAsk = null; } } catch (e) { }
				try { if (HF.panel) { HF.panel.remove(); HF.panel = null; } } catch (e) { }
				HF.open = false;
				boot();
				if (HF.btn) {
					try { } catch (e) { }
				}
			};
			/* 自测/调试接口：window.hfTool._debug.snapshot() / .restore(snap) / .onDamage(evt) … */
				function rectText(node) {
				try {
					var r = node.getBoundingClientRect();
					return Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height);
				} catch (e) { return '?'; }
			}
			function layerTag() {
				try { var L = layer(); return (L === document.documentElement) ? 'html' : ((L === document.body) ? 'body' : 'window'); } catch (e) { return '?'; }
			}
			/* 手机上要是还看不到：控制台执行 hfTool.diag()，会打印并弹窗给出诊断数据 */
			HF.diag = function () {
				var o = {};
				try { o.zoom = game.documentZoom; } catch (e) { o.zoom = '?'; }
				o.layer = layerTag();
				o.open = HF.open; o.tab = HF.tab;
				o.btn = HF.btn ? rectText(HF.btn) : 'none';
				o.panel = HF.panel ? rectText(HF.panel) : 'none';
				try { o.cls = HF.panel ? HF.panel.className : ''; } catch (e) { }
				try { o.bodyFound = !!(HF.panel && HF.panel.getElementsByClassName('hf-body').length); } catch (e) { }
				try { o.tabs = HF.panel ? HF.panel.getElementsByClassName('hf-tab').length : 0; } catch (e) { }
				try { o.styleTag = !!document.getElementById('hf-style'); } catch (e) { }
				try { console.log('[复盘工具] 诊断', JSON.stringify(o)); } catch (e) { }
				toast('复盘诊断 ' + JSON.stringify(o));
				return o;
			};
			HF._debug = {
				snapshot: snapshot, restore: restore, newStat: newStat,
				onDamage: onDamage, onDie: HF.onDie, onUseCard: onUseCard, onUseSkill: onUseSkill,
				seqText: seqText, seqHTML: seqHTML, seqPush: seqPush,
				onGain: onGain, onLose: onLose, onDiscard: onDiscard, onHp: onHp,
				saveRecord: saveRecord, compareText: compareText, recordsText: recordsText, compareHTML: compareHTML,
				addCard: addCardByName, parseCard: parseCardInput, cardKey: resolveCardName,
				cfg: HF.cfg, setCfg: setCfg, applyHandTag: applyHandTag, autoSnapshot: HF.autoSnapshot,
				sideOf: sideOf, sideDamage: sideDamage, snapshotGlobals: snapshotGlobals, restoreGlobals: restoreGlobals,
				statusKeys: function () { ensureStatusScan(); return _statusKeys.slice(0); },
				pileCount: pileCount, callbackPileCat: cardCat, refreshPileBar: refreshPileBar,
				buildButton: buildButton, buildPileBar: buildPileBar, bindTip: bindTip, restorePos: restorePos, hfToast: hfToast,
				ensureOnScreen: ensureOnScreen, dragify: dragify,
				recordStart: HF.recordStart, backToStart: HF.backToStart, buildAsk: buildAsk,
				usableStart: HF.usableStart, noStartTip: HF.noStartTip,
				diagReport: HF.diagReport, copyReport: HF.copyReport,
				updateActions: HF.updateActions,
				openBubbles: HF.openBubbles, closeBubbles: HF.closeBubbles, toggleBubbles: HF.toggleBubbles,
				relayoutBubbles: HF.relayoutBubbles, bubbleVec: HF.bubbleVec,
				/* 测试用：把"到点开点击"的定时器立刻跑掉（模拟泡泡飞到位） */
				flushBubbles: function () {
					try { var l = HF.pbTimers || []; HF.pbTimers = []; l.forEach(function (o) { try { o.fn(); } catch (e) { } }); } catch (e) { }
				},
				resetTap: function () { try { if (HF.resetTap) { HF.resetTap(); } } catch (e) { } },   /* 延迟取：resetTap 在 buildButton 里才赋值 */
				slots: function () { return HF.slots; }, orb: function () { return HF.orb; },
				hookLog: HF.hookLog, askLog: HF.askLog,
				onTurnStart: HF.onTurnStart, onUsePhaseEnd: HF.onUsePhaseEnd,
				hook: HF.hook, diag: HF.diag
			};
			/* 牌堆分类浮标每秒刷一次（隐藏时不计算） */
			if (!HF.pileTimer) { HF.pileTimer = setInterval(function () { refreshPileBar(); }, 1000); }
			console.log('[复盘工具] 已加载：左下角「复」字按钮（也可用 window.hfTool 调用）');
		}
	};
});
