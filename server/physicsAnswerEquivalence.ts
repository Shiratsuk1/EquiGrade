import type { FinalAnswerRule, FinalAnswerSignPolicy } from "../shared/types.js";
export { PHYSICS_SIGN_POLICY_GUIDANCE } from "../shared/modelPrompts.js";

/**
 * The result of comparing one student answer with all acceptable answers in a
 * rubric.  `convention_unclear` is deliberately different from
 * `contradictory`: a different sign is not enough to call a physics answer
 * wrong when the positive direction or work/energy role has not been fixed.
 */
export type PhysicsAnswerComparisonStatus =
  | "equivalent"
  | "contradictory"
  | "convention_unclear"
  | "no_match";

type SignValue = -1 | 0 | 1;
type Direction = "left" | "right" | "up" | "down" | "positive" | "negative" | "zero";
type WorkRole = "external_on_system" | "system_on_external";

interface NumericAtom {
  magnitude: string;
  sign: SignValue;
  explicitSign: boolean;
}

interface ParsedAnswer {
  source: string;
  normalized: string;
  structureKey: string;
  leftKey: string;
  rightKey: string;
  numericAtoms: NumericAtom[];
  direction?: Direction;
  role?: WorkRole;
  likelyWorkQuantity: boolean;
}

export interface PhysicsAnswerCandidateAudit {
  referenceIndex: number;
  referenceExpression: string;
  referenceLabel?: string;
  signPolicy?: FinalAnswerSignPolicy;
  status: PhysicsAnswerComparisonStatus;
  reason: string;
  studentCanonical: string;
  referenceCanonical: string;
  studentMagnitudes: string[];
  referenceMagnitudes: string[];
  studentSigns: SignValue[];
  referenceSigns: SignValue[];
  studentDirection?: Direction;
  referenceDirection?: Direction;
  studentRole?: WorkRole;
  referenceRole?: WorkRole;
  basis: string[];
}

export interface PhysicsAnswerComparisonResult {
  status: PhysicsAnswerComparisonStatus;
  reason: string;
  /** Number of rubric final-answer candidates inspected, including no-match candidates. */
  checkedFinalAnswerCount: number;
  /** All candidates are retained so a reviewer can see why an answer was accepted. */
  candidateAudits: PhysicsAnswerCandidateAudit[];
  /** Every candidate that was equivalent; normally the first one is used by callers. */
  matchedAnswerIndices: number[];
  matchedAnswerIndex?: number;
}

export interface ComparePhysicsAnswerInput {
  studentAnswer: string;
  finalAnswers: readonly FinalAnswerRule[];
}

const NUMBER_PATTERN = /(?<![A-Za-z_])([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:\s*\/\s*(?:\d+(?:\.\d+)?|\.\d+))?)/g;

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[−–—﹣]/g, "-")
    .replace(/[＋]/g, "+")
    .replace(/\\left|\\right/g, "")
    .replace(/\\(?:mathrm|text|textrm)\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "($1)/($2)")
    .replace(/√\s*\{([^{}]*)\}/g, "sqrt($1)")
    .replace(/√\s*\(([^()]*)\)/g, "sqrt($1)")
    .replace(/等于/g, "=")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeDecimal(value: string): string {
  const [wholePart, fractionPart = ""] = value.split(".");
  const whole = wholePart.replace(/^0+(?=\d)/, "") || "0";
  const fraction = fractionPart.replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function normalizeMagnitude(value: string): string {
  const compact = value.replace(/\s+/g, "");
  const slashIndex = compact.indexOf("/");
  if (slashIndex < 0) return normalizeDecimal(compact);

  const numerator = compact.slice(0, slashIndex);
  const denominator = compact.slice(slashIndex + 1);
  if (/^\d+$/.test(numerator) && /^\d+$/.test(denominator) && denominator !== "0") {
    const numeratorBigInt = BigInt(numerator);
    const denominatorBigInt = BigInt(denominator);
    const divisor = gcd(numeratorBigInt, denominatorBigInt);
    const reducedNumerator = numeratorBigInt / divisor;
    const reducedDenominator = denominatorBigInt / divisor;
    return reducedDenominator === 1n
      ? reducedNumerator.toString()
      : `${reducedNumerator.toString()}/${reducedDenominator.toString()}`;
  }
  return `${normalizeDecimal(numerator)}/${normalizeDecimal(denominator)}`;
}

function numericAtoms(value: string): NumericAtom[] {
  const atoms: NumericAtom[] = [];
  for (const match of value.matchAll(NUMBER_PATTERN)) {
    const raw = match[1].replace(/\s+/g, "");
    const first = raw[0];
    const explicitSign = first === "+" || first === "-";
    const magnitude = normalizeMagnitude(explicitSign ? raw.slice(1) : raw);
    const sign: SignValue = magnitude === "0"
      ? 0
      : first === "-" ? -1 : 1;
    atoms.push({ magnitude, sign, explicitSign });
  }
  return atoms;
}

function removeNumericAtoms(value: string): string {
  return value.replace(NUMBER_PATTERN, "#");
}

function directionFromText(value: string): Direction | undefined {
  const normalized = normalizeText(value);
  if (/(?:向右|右方|右侧|right|east|正x|x正方向|x\+|正方向向右)/i.test(normalized)) return "right";
  if (/(?:向左|左方|左侧|left|west|负x|x负方向|x-|负方向向左)/i.test(normalized)) return "left";
  if (/(?:向上|上方|上侧|up|north|正y|y正方向|y\+)/i.test(normalized)) return "up";
  if (/(?:向下|下方|下侧|down|south|负y|y负方向|y-)/i.test(normalized)) return "down";
  return undefined;
}

function oppositeDirection(direction: Direction): Direction | undefined {
  switch (direction) {
    case "left": return "right";
    case "right": return "left";
    case "up": return "down";
    case "down": return "up";
    case "positive": return "negative";
    case "negative": return "positive";
    case "zero": return "zero";
    default: return undefined;
  }
}

function directionFromSign(sign: SignValue, positiveDirection?: Direction): Direction | undefined {
  if (sign === 0) return "zero";
  if (!positiveDirection) return undefined;
  return sign > 0 ? positiveDirection : oppositeDirection(positiveDirection);
}

function roleFromText(value: string): WorkRole | undefined {
  const normalized = normalizeText(value);
  if (/(?:外力|外界|external|ext).{0,10}(?:对|作用于|on).{0,10}(?:系统|物体|object|system)/i.test(normalized)) {
    return "external_on_system";
  }
  if (/(?:系统|物体|object|system).{0,10}(?:对外|向外|to external|external)/i.test(normalized)
    || /(?:对外|向外)做功|(?:对外|向外)作功/i.test(normalized)) {
    return "system_on_external";
  }
  if (/w\s*[_{}]*(?:外|ext|external)/i.test(normalized)) return "external_on_system";
  if (/w\s*[_{}]*(?:系统|物体|system|object)/i.test(normalized)) return "system_on_external";
  if (/(?:外力|外界|external|ext)做功|(?:外力|外界|external|ext)作功/i.test(normalized)) {
    return "external_on_system";
  }
  return undefined;
}

function stripDirectionAnnotations(value: string): string {
  return value
    .replace(/(?:方向|direction)/gi, "")
    .replace(/(?:向左|向右|向上|向下|左方|右方|上方|下方|left|right|up|down|east|west|north|south)/gi, "")
    .replace(/(?:x正方向|x负方向|y正方向|y负方向|正x|负x|正y|负y)/gi, "");
}

function stripRoleAnnotations(value: string): string {
  return value
    .replace(/w\s*[_{}]*(?:外|系统|物体|ext|external|system|object)[_{}]*/gi, "w")
    .replace(/(?:外力|外界|系统|物体|对内|对外|作用于|做功|作功|对|external|system|object|work|on|to)/gi, "");
}

function cleanStructure(value: string): string {
  return value
    .replace(/[\s，,；;。:：、()（）[\]{}]/g, "")
    .replace(/\.+/g, ".")
    .trim();
}

function structureParts(value: string): { full: string; left: string; right: string } {
  const full = cleanStructure(value);
  const equalIndex = full.lastIndexOf("=");
  if (equalIndex < 0) return { full, left: "", right: full };
  return {
    full,
    left: full.slice(0, equalIndex),
    right: full.slice(equalIndex + 1)
  };
}

function compatibleStructure(student: ParsedAnswer, reference: ParsedAnswer, policy?: FinalAnswerSignPolicy): boolean {
  if (student.structureKey === reference.structureKey) return true;

  // A labelled reference such as v=-3 m/s and a student's concise answer
  // such as -3 m/s have the same value-side structure.  Do not discard a
  // mismatched quantity label when both sides provide one.
  const sameValueSide = student.rightKey === reference.rightKey;
  const oneSideUnlabelled = !student.leftKey || !reference.leftKey;
  if (sameValueSide && oneSideUnlabelled) return true;

  // Direction and role annotations are semantic metadata, not part of the
  // algebraic payload.  If both answers carry a recognised annotation, allow
  // the payload to differ in its prose wrapper; signs are checked below.
  if (policy === "direction_dependent"
    && student.direction && reference.direction
    && student.numericAtoms.length === reference.numericAtoms.length) {
    return sameMagnitudeVector(student, reference)
      && (student.likelyWorkQuantity === reference.likelyWorkQuantity || student.numericAtoms.length === 1);
  }
  if (policy === "role_reversal"
    && student.role && reference.role
    && student.likelyWorkQuantity && reference.likelyWorkQuantity) {
    return sameMagnitudeVector(student, reference);
  }
  return false;
}

function sameMagnitudeVector(student: ParsedAnswer, reference: ParsedAnswer): boolean {
  return student.numericAtoms.length > 0
    && student.numericAtoms.length === reference.numericAtoms.length
    && student.numericAtoms.every((atom, index) => atom.magnitude === reference.numericAtoms[index]?.magnitude);
}

function positiveDirectionForRule(rule: FinalAnswerRule): Direction | undefined {
  return directionFromText(rule.positiveDirection ?? rule.signConvention ?? "");
}

function referenceAnswerText(rule: FinalAnswerRule): string {
  return [rule.expression, rule.unit]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(" ");
}

function parseAnswer(value: string, policy?: FinalAnswerSignPolicy, rule?: FinalAnswerRule, annotations = ""): ParsedAnswer {
  const normalized = normalizeText(value);
  const structureSource = policy === "direction_dependent"
    ? stripDirectionAnnotations(normalized)
    : policy === "role_reversal"
      ? stripRoleAnnotations(normalized)
      : normalized;
  const structure = structureParts(removeNumericAtoms(structureSource));
  const atoms = numericAtoms(normalized);
  const semanticText = [normalized, annotations].filter(Boolean).join(" ");
  const explicitDirection = directionFromText(semanticText);
  const derivedDirection = explicitDirection ?? (rule ? directionFromSign(atoms.length === 1 ? atoms[0].sign : 0, positiveDirectionForRule(rule)) : undefined);
  const roleSource = [normalized, annotations, rule?.subject, rule?.signConvention].filter(Boolean).join(" ");
  return {
    source: value,
    normalized,
    structureKey: structure.full,
    leftKey: structure.left,
    rightKey: structure.right,
    numericAtoms: atoms,
    direction: derivedDirection,
    role: roleFromText(roleSource),
    likelyWorkQuantity: /(?:\bw\b|w[_{}]|功|work)/i.test(normalized)
  };
}

function signsEqual(left: ParsedAnswer, right: ParsedAnswer): boolean {
  return left.numericAtoms.length === right.numericAtoms.length
    && left.numericAtoms.every((atom, index) => atom.sign === right.numericAtoms[index]?.sign);
}

function signsDiffer(left: ParsedAnswer, right: ParsedAnswer): boolean {
  return left.numericAtoms.length !== right.numericAtoms.length || !signsEqual(left, right);
}

function roleSign(role: WorkRole | undefined): SignValue {
  return role === "system_on_external" ? -1 : 1;
}

function effectiveRoleSigns(answer: ParsedAnswer): SignValue[] {
  return answer.numericAtoms.map((atom) => {
    const effective = atom.sign * roleSign(answer.role);
    return effective < 0 ? -1 : effective > 0 ? 1 : 0;
  });
}

function formatSigns(signs: SignValue[]): string {
  return `[${signs.join(",")}]`;
}

function compareCandidate(studentAnswer: string, rule: FinalAnswerRule, referenceIndex: number): PhysicsAnswerCandidateAudit {
  const policy = rule.signPolicy;
  const referenceText = referenceAnswerText(rule);
  const student = parseAnswer(studentAnswer, policy);
  const reference = parseAnswer(referenceText, policy, rule, rule.label);
  const basis: string[] = [];
  const common = {
    referenceIndex,
    referenceExpression: rule.expression,
    ...(rule.label ? { referenceLabel: rule.label } : {}),
    ...(policy ? { signPolicy: policy } : {}),
    studentCanonical: student.structureKey,
    referenceCanonical: reference.structureKey,
    studentMagnitudes: student.numericAtoms.map((atom) => atom.magnitude),
    referenceMagnitudes: reference.numericAtoms.map((atom) => atom.magnitude),
    studentSigns: student.numericAtoms.map((atom) => atom.sign),
    referenceSigns: reference.numericAtoms.map((atom) => atom.sign),
    ...(student.direction ? { studentDirection: student.direction } : {}),
    ...(reference.direction ? { referenceDirection: reference.direction } : {}),
    ...(student.role ? { studentRole: student.role } : {}),
    ...(reference.role ? { referenceRole: reference.role } : {}),
    basis
  } satisfies Omit<PhysicsAnswerCandidateAudit, "status" | "reason">;

  if (!studentAnswer.trim() || !rule.expression.trim()) {
    basis.push("学生答案或参考答案为空");
    return { ...common, status: "no_match", reason: "学生答案或参考答案为空，无法进行语义比较。" };
  }

  const hasNumericValues = student.numericAtoms.length > 0 || reference.numericAtoms.length > 0;
  if (hasNumericValues && !sameMagnitudeVector(student, reference)) {
    basis.push("数值大小或数量不一致");
    return { ...common, status: "no_match", reason: "数值大小（含分数约分后结果）或物理量数量不一致。" };
  }

  const structureMatches = compatibleStructure(student, reference, policy);
  if (!structureMatches && !hasNumericValues) {
    basis.push("无数值时表达结构不一致");
    return { ...common, status: "no_match", reason: "未发现可比较的数值，且物理量表达结构不一致。" };
  }
  if (!structureMatches && !(policy === "role_reversal" && student.role && reference.role && student.likelyWorkQuantity && reference.likelyWorkQuantity)) {
    basis.push("物理量或单位结构不一致");
    return { ...common, status: "no_match", reason: "物理量、单位或表达结构不一致，不能仅凭符号作等价判断。" };
  }

  const studentSigns = student.numericAtoms.map((atom) => atom.sign);
  const referenceSigns = reference.numericAtoms.map((atom) => atom.sign);
  if (!hasNumericValues) {
    if (student.direction && reference.direction) {
      basis.push("比较显式方向");
      if (student.direction === reference.direction) {
        return { ...common, status: "equivalent", reason: "无数值时，显式方向一致，物理含义等价。" };
      }
      return { ...common, status: "contradictory", reason: "显式方向相反，物理含义矛盾。" };
    }
    return { ...common, status: "equivalent", reason: "无带符号数值且表达结构一致。" };
  }

  switch (policy) {
    case "magnitude_only":
      basis.push("评分标准声明只比较大小，符号不参与判定");
      return { ...common, status: "equivalent", reason: "评分标准声明该物理量只要求大小，数值大小一致，符号差异可接受。" };

    case "direction_dependent": {
      const studentDirection = student.direction;
      const referenceDirection = reference.direction;
      if (studentDirection && referenceDirection) {
        basis.push("比较方向语义");
        if (studentDirection === referenceDirection) {
          return { ...common, status: "equivalent", reason: "正方向约定或显式方向换算后方向一致，符号差异不改变物理含义。" };
        }
        return { ...common, status: "contradictory", reason: "正方向约定明确且换算后的物理方向相反。" };
      }
      if (signsEqual(student, reference)) {
        basis.push("符号向量一致");
        return { ...common, status: "equivalent", reason: "符号向量一致；当前答案未出现需要解释的方向差异。" };
      }
      basis.push("方向或正方向约定不足，不能解释相反符号");
      return { ...common, status: "convention_unclear", reason: "符号不同，但卷面或评分标准未提供足够的正方向/显式方向，不能安全判错。" };
    }

    case "role_reversal": {
      if (student.role && reference.role) {
        const studentEffectiveSigns = effectiveRoleSigns(student);
        const referenceEffectiveSigns = effectiveRoleSigns(reference);
        basis.push(`按作用主体换算符号：学生${formatSigns(studentEffectiveSigns)}，参考${formatSigns(referenceEffectiveSigns)}`);
        if (studentEffectiveSigns.every((sign, index) => sign === referenceEffectiveSigns[index])) {
          return { ...common, status: "equivalent", reason: "作用主体相反导致的符号变化已换算，功的物理含义一致。" };
        }
        return { ...common, status: "contradictory", reason: "作用主体已明确，换算后的功的符号仍相反。" };
      }
      if (signsEqual(student, reference)) {
        basis.push("符号向量一致");
        return { ...common, status: "equivalent", reason: "符号向量一致；没有需要通过作用主体换算的差异。" };
      }
      basis.push("缺少可识别的作用主体，不能判断符号是否来自角色互换");
      return { ...common, status: "convention_unclear", reason: "符号不同，但未能同时确认对内/对外或作用主体，不能安全判错。" };
    }

    case "fixed_convention":
    case "physically_signed":
      basis.push("比较带符号数值");
      if (signsEqual(student, reference)) {
        return { ...common, status: "equivalent", reason: "在同一正负号约定下，带符号数值一致。" };
      }
      return { ...common, status: "contradictory", reason: "评分标准要求保留该物理量的符号，带符号数值相反。" };

    default:
      // Legacy answer rules have no sign policy.  Equal signs remain safe;
      // opposite signs are sent to review instead of being called wrong.
      basis.push("旧模板未声明符号语义");
      if (signsEqual(student, reference)) {
        return { ...common, status: "equivalent", reason: "旧模板未声明符号语义，但学生与参考答案的符号一致。" };
      }
      return { ...common, status: "convention_unclear", reason: "旧模板未声明正负号语义，符号差异需要人工确认，不能直接判错。" };
  }
}

function compareInput(input: ComparePhysicsAnswerInput): PhysicsAnswerComparisonResult {
  const candidateAudits = input.finalAnswers.map((rule, index) => compareCandidate(input.studentAnswer, rule, index));
  const matchedAnswerIndices = candidateAudits
    .filter((audit) => audit.status === "equivalent")
    .map((audit) => audit.referenceIndex);
  const unclear = candidateAudits.filter((audit) => audit.status === "convention_unclear");
  const contradictory = candidateAudits.filter((audit) => audit.status === "contradictory");

  let status: PhysicsAnswerComparisonStatus;
  if (matchedAnswerIndices.length > 0) {
    status = "equivalent";
  } else if (unclear.length > 0) {
    status = "convention_unclear";
  } else if (contradictory.length > 0) {
    status = "contradictory";
  } else {
    status = "no_match";
  }

  const checked = candidateAudits.length;
  const reason = checked === 0
    ? "评分标准没有可接受的最终答案，无法进行比较。"
    : status === "equivalent"
      ? `已检查全部 ${checked} 套可接受最终答案，其中第 ${matchedAnswerIndices.map((index) => index + 1).join("、")} 套与学生答案等价。`
      : status === "convention_unclear"
        ? `已检查全部 ${checked} 套可接受最终答案，但至少一套存在未声明的符号约定，需人工确认。`
        : status === "contradictory"
          ? `已检查全部 ${checked} 套可接受最终答案，符号语义明确且与参考答案矛盾。`
          : `已检查全部 ${checked} 套可接受最终答案，未找到数值、物理量或符号语义均匹配的候选。`;

  return {
    status,
    reason,
    checkedFinalAnswerCount: checked,
    candidateAudits,
    matchedAnswerIndices,
    ...(matchedAnswerIndices.length > 0 ? { matchedAnswerIndex: matchedAnswerIndices[0] } : {})
  };
}

/** Compare a student answer with every final-answer rule in a rubric. */
export function comparePhysicsAnswer(
  input: ComparePhysicsAnswerInput
): PhysicsAnswerComparisonResult;
export function comparePhysicsAnswer(
  studentAnswer: string,
  finalAnswers: readonly FinalAnswerRule[]
): PhysicsAnswerComparisonResult;
export function comparePhysicsAnswer(
  inputOrStudentAnswer: ComparePhysicsAnswerInput | string,
  finalAnswers?: readonly FinalAnswerRule[]
): PhysicsAnswerComparisonResult {
  return typeof inputOrStudentAnswer === "string"
    ? compareInput({ studentAnswer: inputOrStudentAnswer, finalAnswers: finalAnswers ?? [] })
    : compareInput(inputOrStudentAnswer);
}

/** Descriptive alias for callers that prefer the rubric-oriented name. */
export function compareStudentAnswerToFinalAnswers(
  studentAnswer: string,
  finalAnswers: readonly FinalAnswerRule[]
): PhysicsAnswerComparisonResult {
  return comparePhysicsAnswer(studentAnswer, finalAnswers);
}

export function compareStudentAnswerToFinalAnswer(
  studentAnswer: string,
  finalAnswer: FinalAnswerRule
): PhysicsAnswerComparisonResult {
  return comparePhysicsAnswer(studentAnswer, [finalAnswer]);
}

export function finalAnswerTexts(subquestion: { finalAnswers: readonly FinalAnswerRule[] }): string[] {
  return subquestion.finalAnswers.flatMap((rule) => {
    const raw = [rule.expression, rule.unit].filter(Boolean).join(" ").trim();
    return raw ? [raw] : [];
  });
}

export function normalizeFinalAnswerValue(value: string): string {
  return value.trim().replace(/\s+/g, "");
}

export function finalAnswerValuesMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizeFinalAnswerValue(left);
  const normalizedRight = normalizeFinalAnswerValue(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

export function answerMatchesAnyFinalAnswer(
  value: string,
  subquestion: { finalAnswers: readonly FinalAnswerRule[] }
): boolean {
  return finalAnswerTexts(subquestion).some((expected) => finalAnswerValuesMatch(value, expected))
    || comparePhysicsAnswer(value, subquestion.finalAnswers).status === "equivalent";
}
