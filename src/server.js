'use strict';

const path = require('path');
const express = require('express');
const db = require('./db');
const geom = require('./geom');
const { optimizeRolls } = require('./nest');
const { validateJobInput, validateRevisionInput, LIMITS } = require('./validate');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- 数据访问辅助 ----------

function loadFull(jobId) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) return null;
  const rolls = db
    .prepare('SELECT * FROM rolls WHERE job_id = ? ORDER BY seq')
    .all(jobId);
  const defects = db
    .prepare('SELECT id, roll_id, x, y, w, h FROM defects WHERE job_id = ? ORDER BY id')
    .all(jobId);
  const types = db.prepare('SELECT * FROM piece_types WHERE job_id = ?').all(jobId);
  const revisions = db
    .prepare('SELECT * FROM piece_revisions WHERE job_id = ? ORDER BY piece_type_id, rev')
    .all(jobId);
  const placements = db
    .prepare(
      `SELECT p.*, t.name AS name,
              rv.vertices AS rv_vertices, rv.allow_rotate AS rv_allow_rotate,
              rv.bw AS rv_bw, rv.bh AS rv_bh, rv.rev AS rv_rev
       FROM placements p
       JOIN piece_types t ON t.id = p.piece_type_id
       JOIN piece_revisions rv ON rv.id = p.piece_revision_id
       WHERE p.job_id = ? ORDER BY p.id`
    )
    .all(jobId);
  const remnants = db
    .prepare(
      `SELECT m.*, r.label AS source_roll_label, r.width AS source_roll_width,
              r.length AS source_roll_length, r.cut_line AS source_roll_cut_line,
              j.name AS source_job_name,
              tj.name AS target_job_name,
              tr.label AS target_roll_label
       FROM remnants m
       JOIN rolls r ON r.id = m.source_roll_id
       JOIN jobs j ON j.id = m.source_job_id
       LEFT JOIN jobs tj ON tj.id = m.target_job_id
       LEFT JOIN rolls tr ON tr.id = m.target_roll_id
       WHERE m.source_job_id = ? OR m.target_job_id = ?
       ORDER BY m.id`
    )
    .all(jobId, jobId);
  return { job, rolls, defects, types, revisions, placements, remnants };
}

/**
 * 重算各卷实际占用长度、启用状态与方案状态。
 * 状态规则：全部排入=complete；有已排且有未排=partial；一件未排=draft（仅创建后、未优化过）。
 * 一旦方案曾经优化（状态非 draft），即使全部被移回未排区也保持 partial，不回退 draft。
 */
function recompute(jobId, touch) {
  const cnt = db
    .prepare('SELECT COUNT(*) AS total, COALESCE(SUM(placed), 0) AS placed FROM placements WHERE job_id = ?')
    .get(jobId);
  const rows = db
    .prepare(
      `SELECT r.id, MAX(CASE WHEN p.placed = 1 THEN p.y + rv.bh END) AS ml
       FROM rolls r
       LEFT JOIN placements p ON p.roll_id = r.id
       LEFT JOIN piece_revisions rv ON rv.id = p.piece_revision_id
       WHERE r.job_id = ?
       GROUP BY r.id
       ORDER BY r.seq`
    )
    .all(jobId);
  let totalUsed = 0;
  const updRoll = db.prepare('UPDATE rolls SET used = ?, used_length = ? WHERE id = ?');
  for (const r of rows) {
    const usedLength = r.ml == null ? 0 : r.ml;
    updRoll.run(usedLength > 0 ? 1 : 0, usedLength, r.id);
    totalUsed += usedLength;
  }
  const cur = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId).status;
  let status;
  if (cnt.placed === cnt.total) status = 'complete';
  else if (cnt.placed > 0 || touch || cur === 'partial') status = 'partial';
  else status = 'draft';
  db.prepare('UPDATE jobs SET used_length = ?, status = ? WHERE id = ?').run(totalUsed, status, jobId);
}

/** 组装完整方案状态（API 返回；同时保留单卷旧字段） */
function jobState(jobId) {
  const full = loadFull(jobId);
  if (!full) return null;
  const { job, rolls, defects, types, revisions, placements } = full;
  const revsByType = new Map();
  for (const rv of revisions) {
    if (!revsByType.has(rv.piece_type_id)) revsByType.set(rv.piece_type_id, []);
    revsByType.get(rv.piece_type_id).push(rv);
  }
  const cutCountByRoll = new Map(rolls.map((r) => [r.id, 0]));
  for (const p of placements) {
    if (p.placed && p.cut) cutCountByRoll.set(p.roll_id, (cutCountByRoll.get(p.roll_id) || 0) + 1);
  }
  const rollList = rolls.map((r) => ({
    id: r.id,
    seq: r.seq,
    label: r.label,
    width: r.width,
    length: r.length,
    used: !!r.used,
    usedLength: r.used_length,
    cutLine: r.cut_line,               // 本卷切线（mm）：[0,cutLine) 已裁；0=尚未裁剪
    cutCount: cutCountByRoll.get(r.id) || 0,
    sealed: !!r.sealed,                // 尾料已登记移交：已冻结，不得再排入裁片或推进切线
    sourceRemnantId: r.source_remnant_id, // 非 null=本卷为其他方案尾料领入（值即尾料登记 id）
  }));
  const firstRoll = rolls[0] || null;
  return {
    job: {
      id: job.id,
      name: job.name,
      fabricWidth: job.fabric_width,   // 旧字段：首卷宽度
      fabricLength: job.fabric_length, // 旧字段：首卷长度
      rollCount: rolls.length,
      status: job.status,
      usedLength: job.used_length,     // 各卷占用长度之和（单卷时即原语义）
      createdAt: job.created_at,
    },
    rolls: rollList,
    // 旧字段：首卷瑕疵（旧客户端只看这一卷）
    defects: defects
      .filter((d) => !firstRoll || d.roll_id === firstRoll.id)
      .map((d) => ({ id: d.id, x: d.x, y: d.y, w: d.w, h: d.h })),
    defectsByRoll: rollList.map((r) => ({
      rollId: r.id,
      defects: defects
        .filter((d) => d.roll_id === r.id)
        .map((d) => ({ id: d.id, x: d.x, y: d.y, w: d.w, h: d.h })),
    })),
    pieceTypes: types.map((t) => ({
      id: t.id,
      name: t.name,
      vertices: JSON.parse(t.vertices),
      quantity: t.quantity,
      allowRotate: !!t.allow_rotate,
      bw: t.bw,
      bh: t.bh,
      currentRev: t.current_rev,
      // 全部历史版次（改版后已裁件可能定格在旧版）；最后一个即当前版
      revisions: (revsByType.get(t.id) || []).map((rv) => ({
        id: rv.id,
        rev: rv.rev,
        vertices: JSON.parse(rv.vertices),
        allowRotate: !!rv.allow_rotate,
        bw: rv.bw,
        bh: rv.bh,
        createdAt: rv.created_at,
      })),
    })),
    placements: placements.map((p) => ({
      id: p.id,
      pieceTypeId: p.piece_type_id,
      pieceRevisionId: p.piece_revision_id,
      revision: p.rv_rev,               // 本件实际纸样版次（查询可分辨每件轮廓）
      rollId: p.roll_id,
      requiredRollId: p.required_roll_id,
      name: p.name,
      seq: p.seq,
      x: p.x,
      y: p.y,
      rotation: p.rotation,
      placed: !!p.placed,
      locked: !!p.locked,
      cut: !!p.cut,
      allowRotate: !!p.rv_allow_rotate, // 本件所用版次的旋转许可（已裁件随旧版定格）
      bw: p.rv_bw,
      bh: p.rv_bh,
      reason: p.unplaced_reason || null,
    })),
    unplaced: placements
      .filter((p) => !p.placed)
      .map((p) => ({
        id: p.id,
        name: p.name,
        seq: p.seq,
        rollId: p.required_roll_id,
        reason: p.unplaced_reason || null,
      })),
    // 裁剪进度（按卷；未裁剪的卷 cutLine=0、cutPieces=[]，同样列出）
    cuts: cutSummary(rolls, placements),
    // 尾料移交：outgoing=本方案登记移交出去的尾料；incoming=从其他方案领入形成的独立卷
    remnants: remnantsForJob(full),
  };
}

/** 组装裁剪进度：每卷切线 + 本卷已裁件（按 y、id 排序）。 */
function cutSummary(rolls, placements) {
  return rolls.map((r) => ({
    rollId: r.id,
    seq: r.seq,
    label: r.label,
    width: r.width,
    length: r.length,
    cutLine: r.cut_line,                       // 本卷切线（mm），0=尚未裁剪
    cutCount: placements.filter((p) => p.placed && p.cut && p.roll_id === r.id).length,
    cutPieces: placements
      .filter((p) => p.placed && p.cut && p.roll_id === r.id)
      .map((p) => ({
        id: p.id,
        name: p.name,
        seq: p.seq,
        x: p.x,
        y: p.y,
        rotation: p.rotation,
        requiredRollId: p.required_roll_id,
      }))
      .sort((a, b) => a.y - b.y || a.id - b.id),
  }));
}

// ---------- 尾料移交辅助 ----------

/**
 * 来源卷尾料区间 [startY, endY) 内的瑕疵，按“区间起点为零”重算到目标卷坐标。
 *  - 完全位于起点之后（d.y >= startY）：整体复制，新 y = d.y - startY；
 *  - 跨越起点（d.y < startY < d.y+d.h）：裁掉起点之前部分，新瑕疵 y=0、高 = (d.y+d.h)-startY；
 *  - 完全位于已裁段（d.y+d.h <= startY）：不带入尾料；
 *  - 末端超过 endY 时同样截断（正常数据下瑕疵不越卷界，此处保守兜底）。
 * 宽度/x 不变（整幅移交，布幅方向无平移）。
 */
function remnantDefects(sourceDefects, startY, endY, width) {
  const out = [];
  for (const d of sourceDefects) {
    const top = Math.min(d.y + d.h, endY);
    const bot = Math.max(d.y, startY);
    if (top - bot <= 0) continue; // 与尾料区间无正高度交集：不带入
    const x = Math.max(0, d.x);
    const w = Math.min(d.x + d.w, width) - x;
    if (w <= 0) continue;
    out.push({ x, y: bot - startY, w, h: top - bot });
  }
  return out;
}

/** 组装一条尾料记录的对外状态（defects 为按起点重算后的目标卷瑕疵；available 时动态计算） */
function remnantState(m, defects) {
  return {
    id: m.id,
    status: m.status,                          // available=待领用 | claimed=已领用
    label: m.label,
    width: m.width,
    startY: m.start_y,                        // 来源卷原始区间起点（=登记时切线）
    endY: m.end_y,                            // 来源卷原始区间末端（=来源卷长）
    length: m.length,                         // 尾料长度 mm
    source: {
      jobId: m.source_job_id,
      jobName: m.source_job_name,
      rollId: m.source_roll_id,
      rollLabel: m.source_roll_label,
      rollWidth: m.source_roll_width,
      rollLength: m.source_roll_length,
      cutLine: m.source_roll_cut_line,
    },
    target:
      m.status === 'claimed'
        ? {
            jobId: m.target_job_id,
            jobName: m.target_job_name,
            rollId: m.target_roll_id,
            rollLabel: m.target_roll_label,
            claimedAt: m.claimed_at,
          }
        : null,
    defectCount: defects.length,
    defects,                                  // 重算后的瑕疵（目标卷坐标，原点=区间起点）
    createdAt: m.created_at,
  };
}

/** 组装与某方案相关的尾料：out=本方案登记（出库），in=领入本方案（含其重算瑕疵即新卷瑕疵） */
function remnantsForJob(full) {
  const { rolls, defects, remnants } = full;
  const rollById = new Map(rolls.map((r) => [r.id, r]));
  const out = [];
  const incoming = [];
  for (const m of remnants) {
    if (m.source_job_id === full.job.id) {
      // 出库尾料：瑕疵按来源卷当前瑕疵动态重算（登记后来源卷冻结，瑕疵不会再变）
      const srcDefects = defects.filter((d) => d.roll_id === m.source_roll_id);
      out.push(remnantState(m, remnantDefects(srcDefects, m.start_y, m.end_y, m.width)));
    }
    if (m.status === 'claimed' && m.target_job_id === full.job.id) {
      // 领入尾料：其重算瑕疵已作为目标卷瑕疵落库，直接读取该卷瑕疵（两者一致）
      const tr = rollById.get(m.target_roll_id);
      const trDefects = tr ? defects.filter((d) => d.roll_id === tr.id) : [];
      incoming.push(remnantState(m, trDefects.map((d) => ({ x: d.x, y: d.y, w: d.w, h: d.h }))));
    }
  }
  return { outgoing: out, incoming };
}

// ---------- 路由 ----------

app.get('/api/jobs', (req, res) => {
  const rows = db
    .prepare(
      `SELECT j.id, j.name, j.fabric_width AS fabricWidth, j.fabric_length AS fabricLength,
              j.status, j.used_length AS usedLength, j.created_at AS createdAt,
              (SELECT COUNT(*) FROM rolls r WHERE r.job_id = j.id) AS rollCount,
              (SELECT COUNT(*) FROM placements p WHERE p.job_id = j.id) AS pieceCount
       FROM jobs j ORDER BY j.id DESC`
    )
    .all();
  res.json(rows);
});

app.post('/api/jobs', (req, res) => {
  const { errors, value } = validateJobInput(req.body);
  if (errors.length > 0) {
    return res.status(400).json({ error: '输入不合法，未创建方案', details: errors });
  }
  const tx = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO jobs (name, fabric_width, fabric_length) VALUES (?, ?, ?)')
      .run(value.name, value.rolls[0].width, value.rolls[0].length);
    const jobId = info.lastInsertRowid;
    const insR = db.prepare('INSERT INTO rolls (job_id, seq, label, width, length) VALUES (?, ?, ?, ?, ?)');
    const rollIds = [];
    value.rolls.forEach((r, i) => {
      rollIds.push(insR.run(jobId, i + 1, r.label, r.width, r.length).lastInsertRowid);
    });
    const insD = db.prepare('INSERT INTO defects (job_id, roll_id, x, y, w, h) VALUES (?, ?, ?, ?, ?, ?)');
    value.rolls.forEach((r, i) => {
      for (const d of r.defects) insD.run(jobId, rollIds[i], d.x, d.y, d.w, d.h);
    });
    const insT = db.prepare(
      'INSERT INTO piece_types (job_id, name, vertices, quantity, allow_rotate, bw, bh, current_rev) VALUES (?, ?, ?, ?, ?, ?, ?, 1)'
    );
    const insRv = db.prepare(
      'INSERT INTO piece_revisions (job_id, piece_type_id, rev, vertices, allow_rotate, bw, bh) VALUES (?, ?, 1, ?, ?, ?, ?)'
    );
    const insP = db.prepare(
      'INSERT INTO placements (job_id, piece_type_id, piece_revision_id, seq, required_roll_id) VALUES (?, ?, ?, ?, ?)'
    );
    for (const p of value.pieces) {
      const t = insT.run(
        jobId, p.name, JSON.stringify(p.vertices), p.quantity, p.allowRotate ? 1 : 0, p.bw, p.bh
      );
      const rv = insRv.run(
        jobId, t.lastInsertRowid, JSON.stringify(p.vertices), p.allowRotate ? 1 : 0, p.bw, p.bh
      );
      const revId = rv.lastInsertRowid;
      const reqRollId = p.requiredRollIndex == null ? null : rollIds[p.requiredRollIndex];
      for (let s = 1; s <= p.quantity; s++) insP.run(jobId, t.lastInsertRowid, revId, s, reqRollId);
    }
    return jobId;
  });
  const jobId = tx();
  res.status(201).json(jobState(jobId));
});

app.get('/api/jobs/:id', (req, res) => {
  const state = jobState(Number(req.params.id));
  if (!state) return res.status(404).json({ error: '方案不存在' });
  res.json(state);
});

app.delete('/api/jobs/:id', (req, res) => {
  const info = db.prepare('DELETE FROM jobs WHERE id = ?').run(Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: '方案不存在' });
  res.status(204).end();
});

/**
 * 优化排样（多卷）：锁定件、已裁件与各卷瑕疵固定，重新排入其余未裁裁片。
 * 每卷切线之前的布段 [0, cutLine) 已不可回退地裁下：作为全幅矩形障碍带参与排样，
 * 故所有未裁件在本卷只能位于切线之后（y ≥ cutLine，边接触允许）。
 * 目标：先尽量排入全部裁片，再减少启用卷数、再减少总占用长度（见 nest.optimizeRolls）。
 */
app.post('/api/jobs/:id/optimize', (req, res) => {
  const full = loadFull(Number(req.params.id));
  if (!full) return res.status(404).json({ error: '方案不存在' });
  const { job, rolls, defects, types, placements } = full;
  const rollIndexById = new Map(rolls.map((r, i) => [r.id, i]));

  // 已裁件与锁定件一样固定不动（已裁件同时位于已裁段障碍带内）
  const locked = placements.filter((p) => p.placed && (p.locked || p.cut));
  const rest = placements.filter((p) => !(p.placed && (p.locked || p.cut)));

  const result = optimizeRolls({
    rolls: rolls.map((r) => ({
      label: r.label,
      W: r.width,
      L: r.length,
      // 已裁段视为全幅障碍矩形：未裁件不得进入 [0, cutLine)；
      // 已登记尾料移交的卷，切线之后的整幅尾料区间 [cutLine,length) 同样冻结为障碍，
      // 故未裁件不可能再排入该卷（登记后来源卷不得再排入裁片）。
      defects: [
        ...(r.cut_line > 0 ? [{ x: 0, y: 0, w: r.width, h: r.cut_line }] : []),
        ...(r.sealed ? [{ x: 0, y: r.cut_line, w: r.width, h: r.length - r.cut_line }] : []),
        ...defects.filter((d) => d.roll_id === r.id),
      ],
    })),
    locked: locked.map((p) => ({
      key: p.id,
      rollIndex: rollIndexById.get(p.roll_id),
      verts: JSON.parse(p.rv_vertices),
      rot: p.rotation,
      x: p.x,
      y: p.y,
      w: p.rv_bw,
      h: p.rv_bh,
    })),
    pieces: rest.map((p) => {
      const verts = JSON.parse(p.rv_vertices);
      return {
        key: p.id,
        // 同型号改版后，未裁件可能共用新版掩码；已裁旧版件不会进入这里
        maskKey: 'R' + p.piece_revision_id,
        verts,
        allowRotate: !!p.rv_allow_rotate,
        w: p.rv_bw,
        h: p.rv_bh,
        area: Math.abs(geom.area2(verts)) / 2,
        requiredIndex: p.required_roll_id == null ? null : rollIndexById.get(p.required_roll_id),
      };
    }),
  });

  const lockedIds = new Set(locked.map((p) => p.id));
  const placedById = new Map(result.placements.map((pl) => [pl.key, pl]));
  const reasonById = new Map(result.unplaced.map((u) => [u.key, u.reason]));
  const cutLineByRollId = new Map(rolls.map((r) => [r.id, r.cut_line]));
  const placeById = new Map(placements.map((p) => [p.id, p]));
  // 优化器不感知“已裁段”语义，在必用卷未排入原因中补充切线后剩余长度信息
  const augmentReason = (pid, reason) => {
    const p = placeById.get(pid);
    if (!p || p.required_roll_id == null) return reason;
    const reqRoll = rolls[rollIndexById.get(p.required_roll_id)];
    const cutLine = cutLineByRollId.get(p.required_roll_id) || 0;
    if (reqRoll && reqRoll.sealed) {
      return `${reason}；该卷尾料已登记移交并冻结，不能再排入任何裁片`;
    }
    if (cutLine <= 0) return reason;
    return `${reason}；该卷切线 ${cutLine}mm 之前已裁，未裁件只能排在切线之后（剩余可用长度 ${reqRoll.length - cutLine}mm）`;
  };
  const upd = db.prepare(
    'UPDATE placements SET roll_id = ?, x = ?, y = ?, rotation = ?, placed = 1, unplaced_reason = NULL WHERE id = ?'
  );
  const clr = db.prepare(
    'UPDATE placements SET x = NULL, y = NULL, rotation = 0, placed = 0, unplaced_reason = ? WHERE id = ?'
  );
  const tx = db.transaction(() => {
    for (const pl of result.placements) {
      if (lockedIds.has(pl.key)) continue; // 锁定件/已裁件保持不动（含卷号与位置）
      upd.run(rolls[pl.rollIndex].id, pl.x, pl.y, pl.rotation, pl.key);
    }
    for (const [key, reason] of reasonById) {
      clr.run(augmentReason(key, reason), key);
    }
    // 保险：结果中未出现且非固定的件（理论上不存在）也清回未排区
    for (const p of rest) {
      if (!placedById.has(p.id) && !reasonById.has(p.id)) {
        clr.run('优化器未能排入', p.id);
      }
    }
    recompute(job.id, true); // 优化后即使有件未排也须标记为部分方案
  });
  tx();
  res.json(jobState(job.id));
});

/**
 * 手动移动 / 旋转 / 手动排入（可跨卷）：
 *  - body.rollId 指定目标卷；省略时单卷方案=唯一卷，多卷方案=保持原卷
 *  - 必用卷约束：目标卷必须等于必用卷
 *  - 已裁件的卷号/位置/方向不可再改；未裁件不得进入目标卷已裁段（y ≥ 该卷切线）
 *  - 按目标卷布边、瑕疵及已排裁片精确校验；冲突时指出对象且原方案不变
 *  - 锁定件须先解锁
 */
app.post('/api/jobs/:id/placements/:pid/move', (req, res) => {
  const jobId = Number(req.params.id);
  const pid = Number(req.params.pid);
  const full = loadFull(jobId);
  if (!full) return res.status(404).json({ error: '方案不存在' });
  const { job, rolls, defects, placements } = full;
  const rollById = new Map(rolls.map((r) => [r.id, r]));
  const placement = placements.find((p) => p.id === pid);
  if (!placement) return res.status(404).json({ error: '裁片不存在' });
  const label = `裁片「${placement.name}#${placement.seq}」`;

  if (placement.cut) {
    return res.status(409).json({
      error: `${label}已随切线前布段裁下，卷号、位置、方向均不可再改，也不能移回未排区`,
      conflicts: [label + '（已裁）'],
    });
  }
  if (placement.locked) {
    return res.status(409).json({ error: `${label}已锁定，请先解锁再移动`, conflicts: [label] });
  }

  // ---- 目标卷解析 ----
  let targetRoll;
  const bodyRollId = req.body ? req.body.rollId : undefined;
  if (bodyRollId === undefined || bodyRollId === null) {
    if (rolls.length === 1) targetRoll = rolls[0];
    else if (placement.roll_id != null) targetRoll = rollById.get(placement.roll_id);
    else {
      return res.status(400).json({
        error: `该方案有 ${rolls.length} 卷，跨卷移动必须在请求体中指定目标卷 rollId（可用卷：${rolls
          .map((r) => `${r.id}=${r.label}`)
          .join('、')}）`,
      });
    }
  } else {
    if (!Number.isInteger(bodyRollId)) {
      return res.status(400).json({
        error: `目标卷号无效：rollId 必须为系统返回的卷 id 整数（收到 "${bodyRollId}"）`,
      });
    }
    targetRoll = rollById.get(bodyRollId);
    if (!targetRoll) {
      return res.status(400).json({
        error: `目标卷不存在：方案中没有 rollId=${bodyRollId} 的卷（可用卷：${rolls
          .map((r) => `${r.id}=${r.label}`)
          .join('、')}）`,
      });
    }
  }
  if (!targetRoll) return res.status(400).json({ error: '无法确定目标卷' });

  // ---- 尾料已登记移交的卷已冻结：不得再排入任何裁片 ----
  if (targetRoll.sealed) {
    return res.status(409).json({
      error:
        `卷「${targetRoll.label}」的尾料已登记移交（区间 ${targetRoll.cut_line}~${targetRoll.length}mm）并冻结，` +
        `不能再排入裁片，也不能推进切线，已保留原方案`,
      conflicts: [`卷「${targetRoll.label}」尾料区间 [${targetRoll.cut_line}, ${targetRoll.length}mm) 已登记移交`],
    });
  }

  // ---- 必用卷约束 ----
  if (placement.required_roll_id != null && placement.required_roll_id !== targetRoll.id) {
    const req = rollById.get(placement.required_roll_id);
    return res.status(409).json({
      error: `${label}指定了必用卷「${req ? req.label : placement.required_roll_id}」，不能移动到卷「${targetRoll.label}」`,
      conflicts: [`必用卷「${req ? req.label : placement.required_roll_id}」`],
    });
  }

  const { x, y, rotation } = req.body || {};
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(rotation)) {
    return res.status(400).json({ error: '位置与旋转角度必须为整数（x, y 单位 mm；rotation 为 0 或 180）' });
  }
  if (rotation !== 0 && rotation !== 180) {
    return res.status(400).json({ error: '旋转角度仅支持 0° 或 180°' });
  }
  if (rotation === 180 && !placement.rv_allow_rotate) {
    return res.status(409).json({ error: `${label}不允许旋转（该版纸样禁旋转，须保持原方向）`, conflicts: [label] });
  }
  const w = placement.rv_bw;
  const h = placement.rv_bh;
  if (x < 0 || y < 0 || x + w > targetRoll.width || y + h > targetRoll.length) {
    return res.status(409).json({
      error:
        `${label}移动后超出卷「${targetRoll.label}」布边` +
        `（位置需满足 0≤x≤${targetRoll.width - w}, 0≤y≤${targetRoll.length - h}，该卷 ${targetRoll.width}×${targetRoll.length}mm），已保留原方案`,
      conflicts: [label],
    });
  }

  // ---- 已裁段边界：未裁件不得进入目标卷切线之前（边接触 y == cutLine 允许） ----
  if (targetRoll.cut_line > 0 && y < targetRoll.cut_line) {
    return res.status(409).json({
      error:
        `${label}不能放入卷「${targetRoll.label}」的已裁段` +
        `（该卷切线为 ${targetRoll.cut_line}mm，未裁件须满足 y≥${targetRoll.cut_line}，边接触允许），已保留原方案`,
      conflicts: [`卷「${targetRoll.label}」已裁段 [0, ${targetRoll.cut_line}mm)`],
    });
  }

  const verts = JSON.parse(placement.rv_vertices);
  const abs = geom.toAbsolute(verts, rotation, w, h, x, y);

  const conflicts = [];
  for (const d of defects.filter((d) => d.roll_id === targetRoll.id)) {
    if (geom.polygonsInteriorOverlap(abs, geom.rectPoly(d.x, d.y, d.w, d.h))) {
      conflicts.push(`卷「${targetRoll.label}」瑕疵区#${d.id}（${d.x},${d.y} ${d.w}×${d.h}mm）`);
    }
  }
  for (const q of placements) {
    if (q.id === pid || !q.placed || q.roll_id !== targetRoll.id) continue;
    const qAbs = geom.toAbsolute(JSON.parse(q.rv_vertices), q.rotation, q.rv_bw, q.rv_bh, q.x, q.y);
    if (geom.polygonsInteriorOverlap(abs, qAbs)) {
      const tag = q.cut ? '（已裁）' : q.locked ? '（已锁定）' : '';
      conflicts.push(`卷「${targetRoll.label}」裁片「${q.name}#${q.seq}」${tag}`);
    }
  }
  if (conflicts.length > 0) {
    return res.status(409).json({ error: `${label}移动后与以下对象冲突，已保留原方案`, conflicts });
  }

  db.prepare(
    'UPDATE placements SET roll_id = ?, x = ?, y = ?, rotation = ?, placed = 1, unplaced_reason = NULL WHERE id = ?'
  ).run(targetRoll.id, x, y, rotation, pid);
  recompute(jobId);
  res.json(jobState(jobId));
});

/** 锁定 / 解锁（锁定件与瑕疵在优化中始终固定） */
app.post('/api/jobs/:id/placements/:pid/lock', (req, res) => {
  const jobId = Number(req.params.id);
  const pid = Number(req.params.pid);
  const placement = db
    .prepare(
      `SELECT p.*, t.name FROM placements p JOIN piece_types t ON t.id = p.piece_type_id
       WHERE p.id = ? AND p.job_id = ?`
    )
    .get(pid, jobId);
  if (!placement) return res.status(404).json({ error: '裁片不存在' });
  const label = `裁片「${placement.name}#${placement.seq}」`;
  if (placement.cut) {
    return res.status(409).json({ error: `${label}已裁剪，其卷号与位置已不可回退，无需也不能再更改锁定状态`, conflicts: [label + '（已裁）'] });
  }
  const locked = !!(req.body && req.body.locked);
  if (locked && !placement.placed) {
    return res.status(400).json({ error: `裁片「${placement.name}#${placement.seq}」尚未排入，不能锁定` });
  }
  db.prepare('UPDATE placements SET locked = ? WHERE id = ?').run(locked ? 1 : 0, pid);
  res.json(jobState(jobId));
});

/** 移回未排区（同时解除锁定；保留必用卷约束；已裁件不可移回） */
app.post('/api/jobs/:id/placements/:pid/unplace', (req, res) => {
  const jobId = Number(req.params.id);
  const pid = Number(req.params.pid);
  const placement = db
    .prepare('SELECT p.*, t.name FROM placements p JOIN piece_types t ON t.id = p.piece_type_id WHERE p.id = ? AND p.job_id = ?')
    .get(pid, jobId);
  if (!placement) return res.status(404).json({ error: '裁片不存在' });
  if (placement.cut) {
    return res.status(409).json({
      error: `裁片「${placement.name}#${placement.seq}」已随切线前布段裁下，不能移回未排区`,
      conflicts: [`裁片「${placement.name}#${placement.seq}」（已裁）`],
    });
  }
  db
    .prepare(
      'UPDATE placements SET x = NULL, y = NULL, rotation = 0, placed = 0, locked = 0, unplaced_reason = NULL WHERE id = ? AND job_id = ?'
    )
    .run(pid, jobId);
  recompute(jobId);
  res.json(jobState(jobId));
});

/**
 * 设置 / 取消单件裁片的必用卷约束。
 * body: { rollId } 指定必用卷（id 整数）；{ rollId: null } 取消。
 * 无效卷号、宽度/长度容不下裁片的必用卷约束一律拒绝（400）。
 * 已排入件的卷不会因此自动改变；已锁定件同样只改约束，需重新优化/手动移动才生效。
 * 已裁件的必用卷不可再改；目标卷切线后剩余长度容不下裁片时同样拒绝。
 */
app.post('/api/jobs/:id/placements/:pid/require-roll', (req, res) => {
  const jobId = Number(req.params.id);
  const pid = Number(req.params.pid);
  const full = loadFull(jobId);
  if (!full) return res.status(404).json({ error: '方案不存在' });
  const { rolls, placements } = full;
  const rollById = new Map(rolls.map((r) => [r.id, r]));
  const placement = placements.find((p) => p.id === pid);
  if (!placement) return res.status(404).json({ error: '裁片不存在' });
  const label = `裁片「${placement.name}#${placement.seq}」`;

  if (placement.cut) {
    return res.status(409).json({
      error: `${label}已随切线前布段裁下，必用卷不可再改`,
      conflicts: [label + '（已裁）'],
    });
  }

  const raw = req.body ? req.body.rollId : undefined;
  if (raw !== null && raw !== undefined && !Number.isInteger(raw)) {
    return res.status(400).json({ error: 'rollId 必须为卷 id 整数，或用 null 取消必用卷约束' });
  }
  let target = null;
  if (raw !== null && raw !== undefined) {
    target = rollById.get(raw);
    if (!target) {
      return res.status(400).json({
        error: `卷号无效：方案中没有 rollId=${raw} 的卷（可用卷：${rolls
          .map((r) => `${r.id}=${r.label}`)
          .join('、')}）`,
      });
    }
    if (placement.rv_bw > target.width || placement.rv_bh > target.length) {
      return res.status(400).json({
        error:
          `${label}外接尺寸 ${placement.rv_bw}×${placement.rv_bh}mm 超过必用卷「${target.label}」` +
          `（${target.width}×${target.length}mm），必用卷约束不可能满足，已拒绝`,
      });
    }
    // 目标卷尾料已登记移交并冻结：必用卷约束不可能再满足
    if (target.sealed) {
      return res.status(400).json({
        error:
          `${label}的必用卷「${target.label}」尾料已登记移交并冻结，不能再排入任何裁片，` +
          `必用卷约束不可能满足，已拒绝`,
      });
    }
    // 该卷已有切线时，未裁件只能使用切线之后的剩余段
    const remain = target.length - (target.cut_line || 0);
    if (placement.rv_bh > remain) {
      return res.status(400).json({
        error:
          `${label}外接长度 ${placement.rv_bh}mm 超过必用卷「${target.label}」切线后剩余长度` +
          `（切线 ${target.cut_line}mm，剩余 ${remain}mm），必用卷约束不可能满足，已拒绝`,
      });
    }
  }

  // 仅作用于这一件裁片（创建时按型号统一设置；创建后每件可单独调整）
  db.prepare('UPDATE placements SET required_roll_id = ? WHERE id = ? AND job_id = ?').run(
    target ? target.id : null,
    pid,
    jobId
  );
  res.json(jobState(jobId));
});

// ---------- 改版纸样（按裁片型号修订） ----------

/**
 * 提交某型号的改版纸样：
 *   POST /api/jobs/:id/piece-types/:tid/revisions
 *   body: { vertices: [[x,y],...], quantity: 正整数, allowRotate?: bool }
 *
 * 语义（全部在单个事务内完成；任一校验不通过 → 400/409 且原方案完全不变）：
 *  - 后续再次修订仍针对该型号“当前纸样”；历史版次保留。
 *  - 已裁件（含锁定的已裁件）继续使用各自裁剪时定格的旧轮廓，卷号/坐标/方向/必用卷/裁剪清单不变；
 *  - 其余同型号未裁件改用新轮廓（新外接尺寸、新旋转许可），原必用卷约束不变；
 *  - 缩减（quantity 减少）：先删未排件，再按 placement id 降序删未锁定已排件；绝不删已裁或锁定件；
 *  - 扩增：新增件进入未排区（seq 接该型号最大号之后），无必用卷；
 *  - 锁定的未裁件必须在“原位”满足新轮廓/旋转许可/布边/切线后区域/瑕疵，且与其他保留件不重叠，
 *    否则【整次拒绝】；
 *  - 未锁定已排件按 id 升序在“原位”校验，失效者退回未排区并在 reason 注明原因；
 *  - 前置可行性：只要还有未裁件，至少一卷的切线后剩余段必须容得下新外接尺寸；各必用卷也须容得下。
 * 成功后：同步各卷占用长度与方案状态，查询结果可按每件 revision 分辨其轮廓版本。
 */
app.post('/api/jobs/:id/piece-types/:tid/revisions', (req, res) => {
  const jobId = Number(req.params.id);
  const typeId = Number(req.params.tid);
  const full = loadFull(jobId);
  if (!full) return res.status(404).json({ error: '方案不存在' });
  const { rolls, defects, types, placements } = full;
  const type = types.find((t) => t.id === typeId);
  if (!type) return res.status(404).json({ error: '裁片型号不存在' });

  // ---- 输入本身（轮廓合法、件数正整数） ----
  const { errors, value } = validateRevisionInput(req.body);
  if (errors.length > 0) {
    return res.status(400).json({ error: '改版输入不合法，已保留原方案', details: errors });
  }
  const { vertices: newVerts, quantity: newQty, allowRotate: newAllow, bw: newW, bh: newH } = value;

  const ofType = placements.filter((p) => p.piece_type_id === typeId);
  const cutPieces = ofType.filter((p) => p.cut);          // 已裁（旧轮廓定格，永不动）
  const lockedSurvivors = ofType.filter((p) => !p.cut && p.locked);
  const protectedCount = cutPieces.length + lockedSurvivors.length;
  if (newQty < protectedCount) {
    return res.status(400).json({
      error:
        `目标总件数 ${newQty} 小于该型号不可删除件数 ${protectedCount}` +
        `（已裁 ${cutPieces.length} 件、未裁锁定 ${lockedSurvivors.length} 件均不可删除），已保留原方案`,
    });
  }

  // 裁片总数上限（缩减只减不增，故仅扩增时可能超限）
  if (newQty > ofType.length) {
    const projectedTotal = placements.length - ofType.length + newQty;
    if (projectedTotal > LIMITS.maxTotalPieces) {
      return res.status(400).json({
        error: `改版后裁片总件数 ${projectedTotal} 超出系统上限（${LIMITS.maxTotalPieces} 件），已保留原方案`,
      });
    }
  }

  // ---- 缩减：确定将被删除的件（未排优先；再 id 降序的未锁定已排；已裁/锁定绝不删） ----
  let toDelete = [];
  if (newQty < ofType.length) {
    const need = ofType.length - newQty;
    const removableUnplaced = ofType
      .filter((p) => !p.cut && !p.locked && !p.placed)
      .sort((a, b) => b.id - a.id); // 同阶段内也按 id 降序，行为确定
    const removablePlaced = ofType
      .filter((p) => !p.cut && !p.locked && p.placed)
      .sort((a, b) => b.id - a.id); // id 降序
    toDelete = [...removableUnplaced, ...removablePlaced].slice(0, need);
    if (toDelete.length < need) {
      // 理论上被前面的 protectedCount 校验挡住，这里兜底
      return res.status(400).json({
        error: `可删除件不足（已裁件与锁定件不可删除），无法缩减到 ${newQty} 件，已保留原方案`,
      });
    }
  }
  const deletedIds = new Set(toDelete.map((p) => p.id));
  const survivors = ofType.filter((p) => !deletedIds.has(p.id));
  const uncutSurvivors = survivors.filter((p) => !p.cut);
  const addCount = Math.max(0, newQty - ofType.length);

  // ---- 几何辅助：一件在其当前卷/坐标/方向上的绝对多边形（同型号未裁件改用新轮廓） ----
  const rollById = new Map(rolls.map((r) => [r.id, r]));
  const absOf = (p, verts, w, h) => geom.toAbsolute(verts, p.rotation, w, h, p.x, p.y);
  const effOf = (p) =>
    p.piece_type_id === typeId && !p.cut
      ? { verts: newVerts, w: newW, h: newH, allowRotate: newAllow }
      : { verts: JSON.parse(p.rv_vertices), w: p.rv_bw, h: p.rv_bh, allowRotate: !!p.rv_allow_rotate };
  const labelOf = (p) => `裁片「${p.name}#${p.seq}」`;

  /**
   * 检查某绝对多边形在某卷与“仍保留的已排件/瑕疵”的内部重叠；返回冲突描述数组（空=通过）。
   * ignoreIds 中的件不参与（典型：被校验件自身、已确定退回未排区的件）；已确定删除的件始终忽略。
   * 布边/切线/旋转许可是逐件的一维判定，在调用处给出更准确的信息。
   */
  function conflictsOnRoll(p, abs, roll, ignoreIds) {
    const out = [];
    for (const d of defects.filter((d) => d.roll_id === roll.id)) {
      if (geom.polygonsInteriorOverlap(abs, geom.rectPoly(d.x, d.y, d.w, d.h))) {
        out.push(`卷「${roll.label}」瑕疵区#${d.id}（${d.x},${d.y} ${d.w}×${d.h}mm）`);
      }
    }
    for (const q of placements) {
      if (!q.placed || q.roll_id !== roll.id || q.id === p.id) continue;
      if (ignoreIds.has(q.id) || deletedIds.has(q.id)) continue;
      const e = effOf(q);
      const qAbs = geom.toAbsolute(e.verts, q.rotation, e.w, e.h, q.x, q.y);
      if (geom.polygonsInteriorOverlap(abs, qAbs)) {
        const tag = q.cut ? '（已裁）' : q.locked ? '（已锁定）' : '';
        out.push(`卷「${roll.label}」${labelOf(q)}${tag}`);
      }
    }
    return out;
  }

  // ---- 前置可行性：有未裁件时至少一卷剩余段容得下；各必用卷也须容得下 ----
  // 尾料已登记移交的卷已冻结，未裁件不可能再排入，不参与可行性。
  if (uncutSurvivors.length > 0) {
    const usableRolls = rolls.filter((r) => !r.sealed);
    const anyRollFits = usableRolls.some((r) => newW <= r.width && newH <= r.length - (r.cut_line || 0));
    if (!anyRollFits) {
      return res.status(400).json({
        error:
          `改版后新外接尺寸 ${newW}×${newH}mm 无法放入任何一卷的切线后剩余段` +
          `（至少需要一卷剩余段容纳该尺寸；尾料已登记移交的卷不可再排入），已保留原方案`,
        details: rolls.map((r) =>
          `卷「${r.label}」${r.width}×${r.length - (r.cut_line || 0)}mm（切线 ${r.cut_line || 0}mm 后${r.sealed ? '，尾料已冻结' : ''}）`
        ),
      });
    }
    // 各必用卷：同型号未裁件若有必用卷约束，该卷剩余段必须容得下
    const reqRollIds = [...new Set(uncutSurvivors.map((p) => p.required_roll_id).filter((v) => v != null))];
    for (const rid of reqRollIds) {
      const r = rollById.get(rid);
      if (!r || r.sealed || newW > r.width || newH > r.length - (r.cut_line || 0)) {
        return res.status(400).json({
          error:
            `改版后新外接尺寸 ${newW}×${newH}mm 超过必用卷「${r ? r.label : rid}」切线后剩余段` +
            `（${r ? (r.sealed ? '该卷尾料已登记移交并冻结' : r.width + '×' + (r.length - (r.cut_line || 0)) + 'mm') : '卷不存在'}），必用卷约束不可能满足，已保留原方案`,
        });
      }
    }
  }

  // ---- 锁定的未裁同型号件：必须在原位满足新纸样，否则整次拒绝 ----
  // 不可移动的参照：布边/切线、瑕疵、已裁件、全部锁定件（含本型号其他锁定件，后者用新轮廓）。
  // 未锁定件不在此阶段判定：若它挡住锁定件，稍后的原位校验会把它退回未排区。
  const lockFailures = [];
  for (const p of lockedSurvivors) {
    const roll = rollById.get(p.roll_id);
    const probs = [];
    if (p.rotation === 180 && !newAllow) probs.push('新纸样不允许旋转 180°，该件锁定在 180° 方向');
    if (p.x < 0 || p.y < 0 || p.x + newW > roll.width || p.y + newH > roll.length) {
      probs.push(
        `新外接尺寸 ${newW}×${newH}mm 超出卷「${roll.label}」布边` +
        `（原位 (${p.x},${p.y})，该卷 ${roll.width}×${roll.length}mm）`
      );
    }
    if (p.y < (roll.cut_line || 0)) {
      probs.push(`原位位于卷「${roll.label}」切线 ${roll.cut_line}mm 之前的已裁段（未裁件须 y≥${roll.cut_line}）`);
    }
    const abs = absOf(p, newVerts, newW, newH);
    // 忽略全部未锁定已排件（它们随后按 id 升序逐个定夺）；自身与将删件在函数内已忽略
    const movableIds = new Set(
      placements.filter((q) => q.placed && !q.cut && !q.locked).map((q) => q.id)
    );
    for (const c of conflictsOnRoll(p, abs, roll, movableIds)) probs.push('与 ' + c + ' 冲突');
    if (probs.length > 0) lockFailures.push({ p, probs });
  }
  if (lockFailures.length > 0) {
    return res.status(409).json({
      error:
        `改版后 ${lockFailures.length} 件锁定裁片无法在原位满足新纸样（锁定件须原位合法，否则整次拒绝），已保留原方案`,
      conflicts: lockFailures.flatMap(({ p, probs }) =>
        probs.map((s) => `${labelOf(p)}：${s}`)
      ),
    });
  }

  // ---- 未锁定已排件：按 id 升序在原位校验，失效者退回未排区 ----
  // 参照障碍：瑕疵、已裁件、全部锁定件（锁定阶段已确认合法），以及本阶段先于它通过校验的件。
  // 同型号件换用新轮廓，其他型号件轮廓不变；改版后同型号件的变化可能使其他型号件原位失效，
  // 故所有未锁定已排件【不分型号】统一按 placement id 升序逐个定夺。
  const bounce = []; // { p, reason }
  const bouncedIds = new Set();
  const unlockedPlaced = placements
    .filter((p) => !p.cut && !p.locked && p.placed && !deletedIds.has(p.id))
    .sort((a, b) => a.id - b.id); // id 升序（含本型号与其他型号）
  for (const p of unlockedPlaced) {
    const roll = rollById.get(p.roll_id);
    const e = effOf(p);
    const probs = [];
    if (p.rotation === 180 && !e.allowRotate) probs.push('该版纸样不允许旋转 180°');
    if (p.x < 0 || p.y < 0 || p.x + e.w > roll.width || p.y + e.h > roll.length) {
      probs.push(`超出卷「${roll.label}」布边`);
    }
    if (p.y < (roll.cut_line || 0)) probs.push(`位于卷「${roll.label}」已裁段（切线 ${roll.cut_line}mm）`);
    const abs = absOf(p, e.verts, e.w, e.h);
    // 此前已退回未排区的件不再占空间；已通过的件（锁定件+先通过的未锁定件）正常参与冲突判定
    for (const c of conflictsOnRoll(p, abs, roll, bouncedIds)) probs.push('与 ' + c + ' 冲突');
    if (probs.length > 0) {
      bouncedIds.add(p.id);
      bounce.push({ p, reason: `纸样改版（第 ${type.current_rev + 1} 版）后原位失效：${probs.join('；')}` });
    }
  }

  // ---- 全部前置检查通过，执行修订 ----
  const tx = db.transaction(() => {
    // 删除缩减件（先删 placement；CASCADE 不涉及 revision，因历史版仍被已裁件引用）
    const delP = db.prepare('DELETE FROM placements WHERE id = ?');
    for (const p of toDelete) delP.run(p.id);

    // 写入新版纸样
    const newRev = type.current_rev + 1;
    const rvInfo = db
      .prepare(
        'INSERT INTO piece_revisions (job_id, piece_type_id, rev, vertices, allow_rotate, bw, bh) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(jobId, typeId, newRev, JSON.stringify(newVerts), newAllow ? 1 : 0, newW, newH);
    const newRevId = rvInfo.lastInsertRowid;

    // 型号镜像为当前版；未裁同型号件逐件改挂新版（已裁件保留旧版）
    db.prepare(
      'UPDATE piece_types SET vertices = ?, quantity = ?, allow_rotate = ?, bw = ?, bh = ?, current_rev = ? WHERE id = ?'
    ).run(JSON.stringify(newVerts), newQty, newAllow ? 1 : 0, newW, newH, newRev, typeId);
    const linkNew = db.prepare('UPDATE placements SET piece_revision_id = ? WHERE id = ?');
    for (const p of uncutSurvivors) linkNew.run(newRevId, p.id);

    // 失效的未锁定已排件退回未排区（解锁保留？规格只说退回未排区；锁定状态对未排件无意义，清零）
    const backToPool = db.prepare(
      'UPDATE placements SET x = NULL, y = NULL, rotation = 0, placed = 0, locked = 0, unplaced_reason = ? WHERE id = ?'
    );
    for (const { p, reason } of bounce) backToPool.run(reason, p.id);

    // 扩增件：进入未排区，无必用卷，seq 接最大号之后
    const maxSeq = db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM placements WHERE piece_type_id = ?')
      .get(typeId).m;
    const insP = db.prepare(
      'INSERT INTO placements (job_id, piece_type_id, piece_revision_id, seq, required_roll_id) VALUES (?, ?, ?, ?, NULL)'
    );
    for (let k = 0; k < addCount; k++) insP.run(jobId, typeId, newRevId, maxSeq + k + 1);

    recompute(jobId, true); // 修订视为方案已进入工作流，未排齐时为部分方案
  });
  tx();

  const state = jobState(jobId);
  state.revision = {
    pieceTypeId: typeId,
    name: type.name,
    revision: type.current_rev + 1,
    targetQuantity: newQty,
    previousQuantity: ofType.length,
    deletedPieceIds: toDelete.map((p) => p.id),
    addedCount: addCount,
    bouncedPieceIds: bounce.map((b) => b.p.id),
    cutPieceIdsKept: cutPieces.map((p) => p.id),
  };
  res.json(state);
});

// ---------- 裁剪进度（按卷逐段，不可回退） ----------

/** 查询裁剪进度：各卷切线与已裁件清单 */
app.get('/api/jobs/:id/cuts', (req, res) => {
  const full = loadFull(Number(req.params.id));
  if (!full) return res.status(404).json({ error: '方案不存在' });
  res.json({ job: { id: full.job.id, name: full.job.name }, cuts: cutSummary(full.rolls, full.placements) });
});

/**
 * 确认一卷的裁剪切线（不可回退）。
 * body: { rollId, cutLine }（cutLine 单位 mm，整数；单卷方案可省略 rollId；cutLine 也可用别名 y）。
 * 规则：
 *  - 切线必须为整数毫米、大于上一切线、不超过卷长；
 *  - 切线不得穿过任何已排的未裁件（未裁件整件位于切线之后才合法，边接触允许）；
 *  - 必须至少有一件已排未裁件整体位于切线之前（无新增已裁件视为无效操作）。
 * 确认后：本卷切线推进，切线之前的已排件全部标记为已裁；其卷号/位置/方向/必用卷此后不可再改。
 * 任一规则不满足：说明原因、返回 400/409 且原方案完全不变。
 */
app.post('/api/jobs/:id/cuts', (req, res) => {
  const jobId = Number(req.params.id);
  const full = loadFull(jobId);
  if (!full) return res.status(404).json({ error: '方案不存在' });
  const { rolls, placements } = full;
  const rollById = new Map(rolls.map((r) => [r.id, r]));

  // ---- 目标卷解析（与 move 相同的省略规则） ----
  let roll;
  const bodyRollId = req.body ? req.body.rollId : undefined;
  if (bodyRollId === undefined || bodyRollId === null) {
    if (rolls.length === 1) roll = rolls[0];
    else {
      return res.status(400).json({
        error: `该方案有 ${rolls.length} 卷，确认裁剪必须指定卷 rollId（可用卷：${rolls
          .map((r) => `${r.id}=${r.label}`)
          .join('、')}）`,
      });
    }
  } else {
    if (!Number.isInteger(bodyRollId)) {
      return res.status(400).json({ error: `卷号无效：rollId 必须为卷 id 整数（收到 "${bodyRollId}"）` });
    }
    roll = rollById.get(bodyRollId);
    if (!roll) {
      return res.status(400).json({
        error: `卷不存在：方案中没有 rollId=${bodyRollId} 的卷（可用卷：${rolls
          .map((r) => `${r.id}=${r.label}`)
          .join('、')}）`,
      });
    }
  }

  const cutLine = req.body && req.body.cutLine !== undefined ? req.body.cutLine : req.body ? req.body.y : undefined;
  if (!Number.isInteger(cutLine)) {
    return res.status(400).json({ error: '切线必须为整数毫米（字段 cutLine，单位 mm）' });
  }
  if (roll.sealed) {
    return res.status(409).json({
      error:
        `卷「${roll.label}」的尾料（切线 ${roll.cut_line}mm 之后整幅区间）已登记移交并冻结，` +
        `不能再推进切线，也不能再排入裁片，原方案不变`,
    });
  }
  if (cutLine <= roll.cut_line) {
    return res.status(409).json({
      error:
        roll.cut_line > 0
          ? `切线 ${cutLine}mm 无效：必须严格位于上一切线 ${roll.cut_line}mm 之后（裁剪进度不可回退），原方案不变`
          : `切线 ${cutLine}mm 无效：必须为正整数（首条切线应 ≥1mm），原方案不变`,
    });
  }
  if (cutLine > roll.length) {
    return res.status(409).json({
      error: `切线 ${cutLine}mm 超出卷「${roll.label}」可用长度 ${roll.length}mm，原方案不变`,
    });
  }

  const onRoll = placements.filter((p) => p.placed && p.roll_id === roll.id);
  const straddlers = [];
  const newlyCut = [];
  for (const p of onRoll) {
    if (p.cut) continue; // 已裁件必然位于旧切线之前，跳过
    // 归一化轮廓的外接矩形即 [0,bw]×[0,bh]；未裁件整体位于切线之后 ⇔ y ≥ cutLine（边接触允许）
    if (p.y < cutLine) {
      if (p.y + p.rv_bh <= cutLine) {
        newlyCut.push(p); // 整件在切线之前，随本段裁下
      } else {
        straddlers.push(p); // 穿过切线：y < cutLine < y+bh
      }
    }
  }

  if (straddlers.length > 0) {
    return res.status(409).json({
      error:
        `切线 ${cutLine}mm 穿过卷「${roll.label}」上 ${straddlers.length} 件未裁裁片` +
        `（裁片须整体位于切线之前或之后，边接触允许），已保留原方案`,
      conflicts: straddlers.map((p) => `裁片「${p.name}#${p.seq}」（y ${p.y}~${p.y + p.rv_bh}mm）`),
    });
  }
  if (newlyCut.length === 0) {
    return res.status(409).json({
      error:
        `切线 ${cutLine}mm 处没有新增已裁件（上一切线 ${roll.cut_line}mm 之后无整件位于该线之前的已排裁片），` +
        `确认裁剪不会产生任何进度，已保留原方案`,
    });
  }

  // 交接单明细顺序确定：按 y、placement id 排序（与进度查询一致）
  newlyCut.sort((a, b) => a.y - b.y || a.id - b.id);

  /**
   * 裁剪进度与裁剪交接单在同一事务内原子写入：
   * 切线推进、新裁件标记、交接单及其明细快照要么全部生效，要么整体回滚（失败保持原状态）。
   * 事务内重读切线 + 乐观锁更新 + UNIQUE(roll_id, seq)：同卷并发确认不会产生重复或倒序记录。
   */
  const tx = db.transaction(() => {
    const cur = db.prepare('SELECT cut_line FROM rolls WHERE id = ?').get(roll.id);
    if (!cur || cutLine <= cur.cut_line) {
      const e = new Error('cut line already advanced');
      e.code = 'CUT_ADVANCED';
      e.current = cur ? cur.cut_line : null;
      throw e;
    }
    // 乐观锁：仅当切线仍为事务内读到的值时才推进（并发下只有一个确认能生效）
    const info = db
      .prepare('UPDATE rolls SET cut_line = ? WHERE id = ? AND cut_line = ?')
      .run(cutLine, roll.id, cur.cut_line);
    if (info.changes !== 1) {
      const e = new Error('cut line already advanced');
      e.code = 'CUT_ADVANCED';
      e.current = cur.cut_line;
      throw e;
    }
    // 标记本次新裁件；若某件已被并发确认裁下，整批回滚
    const mark = db.prepare('UPDATE placements SET cut = 1 WHERE id = ? AND cut = 0');
    for (const p of newlyCut) {
      if (mark.run(p.id).changes !== 1) {
        const e = new Error('piece already cut');
        e.code = 'CUT_ADVANCED';
        e.current = cur.cut_line;
        throw e;
      }
    }
    // 交接单：该卷序号严格递增（UNIQUE(roll_id, seq) 兜底，重试/并发不产生重复单）
    const seq =
      db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM cut_batches WHERE roll_id = ?').get(roll.id).m + 1;
    const batchId = db
      .prepare(
        'INSERT INTO cut_batches (job_id, roll_id, seq, prev_cut_line, cut_line, piece_count) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(jobId, roll.id, seq, cur.cut_line, cutLine, newlyCut.length).lastInsertRowid;
    // 明细为确认时刻快照：件号/纸样版次/轮廓/坐标/方向定格，后续改版与重排样不回写
    const insItem = db.prepare(
      `INSERT INTO cut_batch_items
         (batch_id, job_id, roll_id, placement_id, piece_name, seq, revision, vertices, bw, bh, x, y, rotation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const p of newlyCut) {
      insItem.run(
        batchId, jobId, roll.id, p.id, p.name, p.seq,
        p.rv_rev, p.rv_vertices, p.rv_bw, p.rv_bh, p.x, p.y, p.rotation
      );
    }
    return { batchId, batchSeq: seq, prevCutLine: cur.cut_line };
  });
  let batchInfo;
  try {
    batchInfo = tx();
  } catch (e) {
    if (e && e.code === 'CUT_ADVANCED') {
      return res.status(409).json({
        error:
          `切线 ${cutLine}mm 未能确认：卷「${roll.label}」的裁剪进度已被另一确认推进` +
          `（当前切线 ${e.current}mm），本次操作已整体回滚，原方案不变`,
      });
    }
    throw e;
  }
  // 切线只记录裁剪进度，不改变卷占用/方案状态，无需 recompute
  const state = jobState(jobId);
  state.cut = {
    rollId: roll.id,
    label: roll.label,
    previousCutLine: batchInfo.prevCutLine,
    cutLine,
    newCutPieceIds: newlyCut.map((p) => p.id),
    newCutCount: newlyCut.length,
    batchId: batchInfo.batchId,   // 本次生成的裁剪交接单号（不可改）
    batchSeq: batchInfo.batchSeq, // 该卷第几张交接单
  };
  res.json(state);
});

// ---------- 裁剪交接单（不可改快照；按卷与确认顺序查询，网页可查看并打印） ----------

/** 组装一张交接单（含明细快照；明细按写入顺序即 y、placement id 排列） */
function batchState(row, rollLabel, roll) {
  const items = db.prepare('SELECT * FROM cut_batch_items WHERE batch_id = ? ORDER BY id').all(row.id);
  return {
    id: row.id,
    rollId: row.roll_id,
    rollLabel,
    sourceRemnantId: roll ? roll.source_remnant_id : null, // 裁剪卷若为领入尾料，带来源尾料 id（可追溯）
    seq: row.seq,                          // 该卷第几张交接单（确认顺序）
    previousCutLine: row.prev_cut_line,    // 本次切线前位置
    cutLine: row.cut_line,                 // 本次切线后位置
    pieceCount: row.piece_count,
    createdAt: row.created_at,
    pieces: items.map((it) => ({
      placementId: it.placement_id,        // 本次新裁件 ID
      name: it.piece_name,
      seq: it.seq,                         // 件号
      revision: it.revision,               // 裁剪时纸样版次（定格）
      vertices: JSON.parse(it.vertices),   // 裁剪时轮廓（定格）
      bw: it.bw,
      bh: it.bh,
      x: it.x,
      y: it.y,                             // 卷内坐标（定格）
      rotation: it.rotation,               // 方向（定格）
    })),
  };
}

/**
 * 查询裁剪交接单：GET /api/jobs/:id/cut-batches[?rollId=N]
 * 按卷（卷序号）与确认顺序（单内 seq）排列；附无批次历史的已裁件（升级前已裁，
 * 缺少逐次切线边界，系统不为其推造交接单，仅如实标识）。
 */
app.get('/api/jobs/:id/cut-batches', (req, res) => {
  const jobId = Number(req.params.id);
  const full = loadFull(jobId);
  if (!full) return res.status(404).json({ error: '方案不存在' });
  const { job, rolls, placements } = full;
  const rollById = new Map(rolls.map((r) => [r.id, r]));

  let rollFilter = null;
  if (req.query.rollId !== undefined && req.query.rollId !== null && req.query.rollId !== '') {
    rollFilter = Number(req.query.rollId);
    if (!Number.isInteger(rollFilter) || !rollById.has(rollFilter)) {
      return res.status(400).json({
        error: `rollId 无效：方案中没有该卷（可用卷：${rolls.map((r) => `${r.id}=${r.label}`).join('、')}）`,
      });
    }
  }

  const rows = db
    .prepare(
      `SELECT b.* FROM cut_batches b JOIN rolls r ON r.id = b.roll_id
       WHERE b.job_id = ? ${rollFilter != null ? 'AND b.roll_id = ?' : ''}
       ORDER BY r.seq, b.seq`
    )
    .all(...(rollFilter != null ? [jobId, rollFilter] : [jobId]));

  // 无批次历史的已裁件：已裁但不在本方案任何交接单明细中（升级前已裁，不推造交接单）
  const inBatch = new Set(
    db.prepare('SELECT placement_id FROM cut_batch_items WHERE job_id = ?').all(jobId).map((r) => r.placement_id)
  );
  const legacyCutPieces = placements
    .filter((p) => p.cut && !inBatch.has(p.id))
    .map((p) => ({
      placementId: p.id,
      name: p.name,
      seq: p.seq,
      rollId: p.roll_id,
      rollLabel: rollById.has(p.roll_id) ? rollById.get(p.roll_id).label : null,
      revision: p.rv_rev,
      x: p.x,
      y: p.y,
      rotation: p.rotation,
      batchHistory: false, // 无批次历史（升级前已裁，缺少逐次切线边界）
    }));

  res.json({
    job: { id: job.id, name: job.name },
    batches: rows.map((row) => {
      const rr = rollById.get(row.roll_id);
      return batchState(row, rr.label, rr);
    }),
    legacyCutPieces,
  });
});

/** 单张交接单详情（打印页用）：GET /api/jobs/:id/cut-batches/:bid */
app.get('/api/jobs/:id/cut-batches/:bid', (req, res) => {
  const jobId = Number(req.params.id);
  const full = loadFull(jobId);
  if (!full) return res.status(404).json({ error: '方案不存在' });
  const row = db
    .prepare('SELECT * FROM cut_batches WHERE id = ? AND job_id = ?')
    .get(Number(req.params.bid), jobId);
  if (!row) return res.status(404).json({ error: '交接单不存在' });
  const roll = full.rolls.find((r) => r.id === row.roll_id);
  res.json({
    job: { id: full.job.id, name: full.job.name },
    batch: batchState(row, roll ? roll.label : String(row.roll_id), roll || null),
  });
});

// ---------- 尾料移交（登记整幅尾料区间；跨方案领用一次） ----------

/** 解析某方案中的卷：body.rollId 省略时单卷方案=唯一卷；失败时返回 {fail:{status,body}} */
function resolveRollForWrite(req, rolls, multiRequiredVerb) {
  const rollById = new Map(rolls.map((r) => [r.id, r]));
  const bodyRollId = req.body ? req.body.rollId : undefined;
  if (bodyRollId === undefined || bodyRollId === null) {
    if (rolls.length === 1) return { roll: rolls[0] };
    return {
      fail: {
        status: 400,
        body: {
          error: `该方案有 ${rolls.length} 卷，${multiRequiredVerb}必须指定卷 rollId（可用卷：${rolls
            .map((r) => `${r.id}=${r.label}`)
            .join('、')}）`,
        },
      },
    };
  }
  if (!Number.isInteger(bodyRollId)) {
    return {
      fail: {
        status: 400,
        body: { error: `卷号无效：rollId 必须为卷 id 整数（收到 "${bodyRollId}"）` },
      },
    };
  }
  const roll = rollById.get(bodyRollId);
  if (!roll) {
    return {
      fail: {
        status: 400,
        body: {
          error: `卷不存在：方案中没有 rollId=${bodyRollId} 的卷（可用卷：${rolls
            .map((r) => `${r.id}=${r.label}`)
            .join('、')}）`,
        },
      },
    };
  }
  return { roll };
}

/**
 * 登记整幅尾料区间（尾料移交第一步）。
 *   POST /api/jobs/:id/remnants   body: { rollId?, label? }
 * 条件（任一不满足返回 400/409 并保持原状态）：
 *  - 来源卷已有确认切线（cutLine > 0）；
 *  - 切线之后没有未裁的已排入件；
 *  - 切线之后剩余长度 > 0（cutLine < length）；
 *  - 该卷未登记过尾料（每卷只能登记一次），且未处于冻结状态。
 * 成功：冻结来源卷（sealed=1），写入尾料记录（区间 [cutLine,length)），来源卷此后不得再排入裁片或推进切线。
 */
app.post('/api/jobs/:id/remnants', (req, res) => {
  const jobId = Number(req.params.id);
  const full = loadFull(jobId);
  if (!full) return res.status(404).json({ error: '方案不存在' });
  const { rolls, defects, placements } = full;

  const resolved = resolveRollForWrite(req, rolls, '登记尾料');
  if (resolved.fail) return res.status(resolved.fail.status).json(resolved.fail.body);
  const roll = resolved.roll;

  if (roll.sealed) {
    return res.status(409).json({
      error:
        `卷「${roll.label}」已登记过尾料移交（区间 ${roll.cut_line}~${roll.length}mm），` +
        `同一卷尾料只能登记、移交一次，原方案不变`,
    });
  }
  if (roll.cut_line <= 0) {
    return res.status(409).json({
      error:
        `卷「${roll.label}」尚未确认过切线（切线为 0）：尾料登记要求来源卷已有确认切线，` +
        `请先确认切线再登记整幅尾料区间，原方案不变`,
    });
  }
  const remaining = roll.length - roll.cut_line;
  if (remaining <= 0) {
    return res.status(409).json({
      error:
        `卷「${roll.label}」切线 ${roll.cut_line}mm 已到卷末端（卷长 ${roll.length}mm），` +
        `切线后剩余长度为 0，没有可移交的尾料，原方案不变`,
    });
  }
  // 切线之后不得有未裁的已排入件（已裁件都在切线之前）
  const uncutAfter = placements.filter(
    (p) => p.placed && !p.cut && p.roll_id === roll.id && p.y + p.rv_bh > roll.cut_line
  );
  if (uncutAfter.length > 0) {
    return res.status(409).json({
      error:
        `卷「${roll.label}」切线 ${roll.cut_line}mm 之后还有 ${uncutAfter.length} 件未裁的已排入裁片，` +
        `不能登记整幅尾料（应先裁剪或移走这些裁片），原方案不变`,
      conflicts: uncutAfter
        .sort((a, b) => a.y - b.y || a.id - b.id)
        .map((p) => `裁片「${p.name}#${p.seq}」（y ${p.y}~${p.y + p.rv_bh}mm）`),
    });
  }

  // label：尾料说明，可省略；默认「来源卷号 尾料（cutLine~lengthmm）」
  let label = req.body && typeof req.body.label === 'string' ? req.body.label.trim() : '';
  if (!label) label = `${roll.label} 尾料（${roll.cut_line}~${roll.length}mm）`;
  label = label.slice(0, 100);

  // 跨起点截断/重算后的瑕疵（登记时定格个数；瑕疵本体随来源卷冻结不再变化）
  const transformed = remnantDefects(
    defects.filter((d) => d.roll_id === roll.id),
    roll.cut_line,
    roll.length,
    roll.width
  );

  const tx = db.transaction(() => {
    const cur = db.prepare('SELECT cut_line, sealed FROM rolls WHERE id = ?').get(roll.id);
    if (!cur) {
      const e = new Error('roll gone');
      e.code = 'REMNANT_CONFLICT';
      throw e;
    }
    if (cur.sealed) {
      const e = new Error('remnant already registered');
      e.code = 'REMNANT_CONFLICT';
      throw e;
    }
    // 冻结来源卷；UNIQUE(source_roll_id) 兜底重复登记
    db.prepare('UPDATE rolls SET sealed = 1 WHERE id = ?').run(roll.id);
    const info = db
      .prepare(
        `INSERT INTO remnants
           (source_job_id, source_roll_id, status, label, width, start_y, end_y, length, defect_count)
         VALUES (?, ?, 'available', ?, ?, ?, ?, ?, ?)`
      )
      .run(jobId, roll.id, label, roll.width, roll.cut_line, roll.length, remaining, transformed.length);
    return info.lastInsertRowid;
  });
  let remnantId;
  try {
    remnantId = tx();
  } catch (e) {
    if (e && /UNIQUE/i.test(String(e.message || ''))) {
      return res.status(409).json({ error: `卷「${roll.label}」已登记过尾料移交，不能重复登记，原方案不变` });
    }
    throw e;
  }

  const state = jobState(jobId);
  state.remnant = state.remnants.outgoing.find((m) => m.id === remnantId) || null;
  res.status(201).json(state);
});

/** 组装 remnants 表行的对外状态（含动态重算瑕疵）；m 需带 join 字段 */
function remnantRowState(m) {
  const srcDefects = db
    .prepare('SELECT x, y, w, h FROM defects WHERE roll_id = ? ORDER BY id')
    .all(m.source_roll_id);
  const transformed = remnantDefects(srcDefects, m.start_y, m.end_y, m.width);
  return remnantState(m, transformed);
}

const remnantJoinSql = `
  SELECT m.*, r.label AS source_roll_label, r.width AS source_roll_width,
         r.length AS source_roll_length, r.cut_line AS source_roll_cut_line,
         j.name AS source_job_name,
         tj.name AS target_job_name,
         tr.label AS target_roll_label
  FROM remnants m
  JOIN rolls r ON r.id = m.source_roll_id
  JOIN jobs j ON j.id = m.source_job_id
  LEFT JOIN jobs tj ON tj.id = m.target_job_id
  LEFT JOIN rolls tr ON tr.id = m.target_roll_id
`;

/**
 * 浏览尾料（跨方案领用前查看）。
 *   GET /api/remnants                  全部尾料（按登记时间倒序）
 *   GET /api/remnants?status=available 仅待领用
 *   GET /api/remnants?status=claimed   仅已领用（追溯来源方案/卷/原始区间）
 * 每条含来源方案、来源卷、原始区间与按起点重算后的瑕疵。
 */
app.get('/api/remnants', (req, res) => {
  let where = '';
  const params = [];
  const st = req.query.status;
  if (st !== undefined) {
    if (st !== 'available' && st !== 'claimed') {
      return res.status(400).json({ error: 'status 仅支持 available 或 claimed' });
    }
    where = 'WHERE m.status = ?';
    params.push(st);
  }
  const rows = db.prepare(`${remnantJoinSql} ${where} ORDER BY m.id DESC`).all(...params);
  res.json({ remnants: rows.map(remnantRowState) });
});

/** 单条尾料详情（领用前核查/追溯） */
app.get('/api/remnants/:rid', (req, res) => {
  const rid = Number(req.params.rid);
  if (!Number.isInteger(rid)) return res.status(400).json({ error: '尾料 id 必须为整数' });
  const m = db.prepare(`${remnantJoinSql} WHERE m.id = ?`).get(rid);
  if (!m) return res.status(404).json({ error: '尾料不存在（可能已随来源方案删除）' });
  res.json({ remnant: remnantRowState(m) });
});

/**
 * 领用尾料到目标方案（尾料移交第二步；只能跨方案领用一次）。
 *   POST /api/remnants/:rid/claim   body: { targetJobId, label? }
 * 规则（任一不满足返回 400/404/409，两方案均不产生部分变更）：
 *  - 尾料存在且状态为 available；已领用/重复/并发领用 → 409 冲突；
 *  - 目标方案存在且不是来源方案；
 *  - 领用后目标方案卷数不超过上限（50）；目标方案内卷号唯一（label 重名 → 409）。
 * 成功（单事务）：尾料置 claimed；目标方案新增一卷（宽=尾料宽、长=尾料长，cutLine=0，未冻结），
 * 瑕疵以尾料区间起点为零重算后复制到新卷（跨起点的瑕疵裁截到起点）；新卷带 sourceRemnantId 可追溯。
 */
app.post('/api/remnants/:rid/claim', (req, res) => {
  const rid = Number(req.params.rid);
  if (!Number.isInteger(rid)) return res.status(400).json({ error: '尾料 id 必须为整数' });

  const body = req.body || {};
  const targetJobId = Number(body.targetJobId);
  if (!Number.isInteger(targetJobId)) {
    return res.status(400).json({ error: 'targetJobId 必须为目标方案 id 整数' });
  }
  const targetJob = db.prepare('SELECT * FROM jobs WHERE id = ?').get(targetJobId);
  if (!targetJob) return res.status(404).json({ error: `目标方案不存在：没有 id=${targetJobId} 的方案` });

  let label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 50) : '';

  const tx = db.transaction(() => {
    // 事务内重读 + 条件 UPDATE：并发领用只有一个能把 available 改成 claimed
    const m = db.prepare('SELECT * FROM remnants WHERE id = ?').get(rid);
    if (!m) {
      const e = new Error('remnant not found');
      e.code = 'REMNANT_NOT_FOUND';
      throw e;
    }
    if (m.status !== 'available') {
      const e = new Error('remnant already claimed');
      e.code = 'REMNANT_CONFLICT';
      throw e;
    }
    if (m.source_job_id === targetJobId) {
      const e = new Error('cannot claim own remnant');
      e.code = 'REMNANT_SAME_JOB';
      throw e;
    }
    const targetRolls = db.prepare('SELECT * FROM rolls WHERE job_id = ? ORDER BY seq').all(targetJobId);
    if (targetRolls.length >= LIMITS.maxRolls) {
      const e = new Error('too many rolls');
      e.code = 'REMNANT_TOO_MANY_ROLLS';
      throw e;
    }
    // 默认卷号：尾料#登记id；显式卷号在目标方案内必须唯一
    if (!label) label = `尾料#${m.id}`;
    if (targetRolls.some((r) => r.label === label)) {
      const e = new Error('duplicate label');
      e.code = 'REMNANT_LABEL_DUP';
      e.label = label;
      throw e;
    }

    // 条件更新：仅当仍为 available 时生效（并发下失败者 changes=0）
    const claimAt = db.prepare("SELECT datetime('now') AS t").get().t;
    const info = db
      .prepare("UPDATE remnants SET status = 'claimed', target_job_id = ?, claimed_at = ? WHERE id = ? AND status = 'available'")
      .run(targetJobId, claimAt, rid);
    if (info.changes !== 1) {
      const e = new Error('remnant claimed concurrently');
      e.code = 'REMNANT_CONFLICT';
      throw e;
    }

    // 新增独立卷：整幅尾料宽度、长度=区间长度，未裁剪、未冻结，作为目标方案普通卷参与移动/优化/后续裁剪
    const seq = targetRolls.length + 1;
    const rollInfo = db
      .prepare(
        'INSERT INTO rolls (job_id, seq, label, width, length, used, used_length, cut_line, sealed, source_remnant_id) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, ?)'
      )
      .run(targetJobId, seq, label, m.width, m.length, rid);
    const newRollId = rollInfo.lastInsertRowid;

    // 瑕疵以区间起点为零重算（跨起点裁截），复制到新卷
    const srcDefects = db
      .prepare('SELECT x, y, w, h FROM defects WHERE roll_id = ? ORDER BY id')
      .all(m.source_roll_id);
    const transformed = remnantDefects(srcDefects, m.start_y, m.end_y, m.width);
    const insD = db.prepare('INSERT INTO defects (job_id, roll_id, x, y, w, h) VALUES (?, ?, ?, ?, ?, ?)');
    for (const d of transformed) insD.run(targetJobId, newRollId, d.x, d.y, d.w, d.h);

    db.prepare('UPDATE remnants SET target_roll_id = ?, defect_count = ? WHERE id = ?').run(
      newRollId,
      transformed.length,
      rid
    );
    return { newRollId, seq, defectCount: transformed.length };
  });

  let result;
  try {
    result = tx();
  } catch (e) {
    if (!e) throw e;
    if (e.code === 'REMNANT_NOT_FOUND') {
      return res.status(404).json({ error: '尾料不存在（可能已随来源方案删除）' });
    }
    if (e.code === 'REMNANT_SAME_JOB') {
      return res.status(400).json({ error: '尾料只能跨方案领用：目标方案与来源方案相同，不能领回本方案' });
    }
    if (e.code === 'REMNANT_TOO_MANY_ROLLS') {
      return res.status(409).json({ error: `目标方案卷数已达上限（${LIMITS.maxRolls} 卷），不能再领入尾料，两方案均未变更` });
    }
    if (e.code === 'REMNANT_LABEL_DUP') {
      return res.status(409).json({ error: `目标方案中已存在卷号「${e.label}」，卷号必须唯一，请换用其他 label，两方案均未变更` });
    }
    if (e.code === 'REMNANT_CONFLICT') {
      return res.status(409).json({
        error: `尾料 #${rid} 已被领用（或正被另一请求领用）：尾料只能跨方案领用一次，本次操作已整体回滚，两方案均不产生部分变更`,
      });
    }
    throw e;
  }

  const state = jobState(targetJobId);
  const newRoll = state.rolls.find((r) => r.id === result.newRollId);
  state.claim = {
    remnantId: rid,
    targetJobId,
    rollId: result.newRollId,
    seq: result.seq,
    label: newRoll.label,
    width: newRoll.width,
    length: newRoll.length,
    defectCount: result.defectCount,
  };
  res.status(201).json(state);
});

// ---------- 错误处理与启动 ----------

app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: '请求体不是合法 JSON' });
  }
  res.status(500).json({ error: '服务器内部错误' });
});

const PORT = Number(process.env.PORT) || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`布料裁片排样系统已启动：http://localhost:${PORT}`);
  });
}

module.exports = app;
