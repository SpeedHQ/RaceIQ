// Babel discovery and source-field normalization helpers.
import { parse } from "@babel/parser";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ROOT,
  PARSER_FILES,
} from "./model";
import type {
  AstNode,
  FieldInfo,
  FieldSet,
  GameId,
  ParserOutput,
  UnavailableLink,
} from "./model";

function ast(source: string): AstNode {
  return parse(source, {
    sourceType: "module",
    plugins: ["typescript"],
    attachComment: true,
  }) as unknown as AstNode;
}

function walk(node: unknown, visit: (node: AstNode) => void): void {
  if (!node || typeof node !== "object") return;
  const record = node as AstNode;
  if (typeof record.type === "string") visit(record);
  for (const [key, value] of Object.entries(record)) {
    if (
      key === "loc" ||
      key === "leadingComments" ||
      key === "trailingComments" ||
      key === "innerComments"
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit);
    } else {
      walk(value, visit);
    }
  }
}

function propertyName(node: AstNode): string | undefined {
  if (node.type === "Identifier") return node.name;
  if (node.type === "StringLiteral" || node.type === "NumericLiteral") {
    return String(node.value);
  }
  return undefined;
}

function objectProperties(node: AstNode): Map<string, AstNode> {
  const result = new Map<string, AstNode>();
  if (node?.type !== "ObjectExpression") return result;
  for (const property of node.properties ?? []) {
    if (property.type !== "ObjectProperty") continue;
    const name = propertyName(property.key);
    if (name) result.set(name, property.value);
  }
  return result;
}

function objectCandidate(
  tree: AstNode,
  variableName: string,
): Map<string, AstNode> {
  let best = new Map<string, AstNode>();
  walk(tree, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id?.type === "Identifier" &&
      node.id.name === variableName &&
      node.init?.type === "ObjectExpression"
    ) {
      const candidate = objectProperties(node.init);
      if (candidate.size > best.size) best = candidate;
    }
  });
  return best;
}

function largestReturnObject(tree: AstNode): Map<string, AstNode> {
  let best = new Map<string, AstNode>();
  walk(tree, (node) => {
    if (node.type !== "ReturnStatement" || node.argument?.type !== "ObjectExpression") {
      return;
    }
    const candidate = objectProperties(node.argument);
    if (candidate.size > best.size) best = candidate;
  });
  return best;
}

function variableInitializers(tree: AstNode): Map<string, AstNode> {
  const result = new Map<string, AstNode>();
  walk(tree, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id?.type === "Identifier" &&
      node.init
    ) {
      result.set(node.id.name, node.init);
    }
  });
  return result;
}

async function parserOutput(gameId: GameId): Promise<ParserOutput> {
  const source = (await readFile(resolve(ROOT, PARSER_FILES[gameId]), "utf8")).replace(/\r\n?/g, "\n");
  const tree = ast(source);
  const properties =
    gameId === "iracing"
      ? largestReturnObject(tree)
      : objectCandidate(tree, "packet");
  if (properties.size < 90) {
    throw new Error(`${gameId} packet object extraction found only ${properties.size} fields`);
  }
  return { source, properties, variables: variableInitializers(tree) };
}

function cleanComment(value: string): string {
  return value
    .replace(/^\*+|\*+$/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*\s?/, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function fieldDescription(node: AstNode, _name: string): string | undefined {
  const comments = node.leadingComments as
    | { value?: string; loc?: { start?: { line?: number } } }[]
    | undefined;
  const trailing = node.trailingComments as
    | { value?: string; loc?: { start?: { line?: number } } }[]
    | undefined;
  const nodeEndLine = node.loc?.end?.line;
  const value =
    trailing?.find((comment) => comment.loc?.start?.line === nodeEndLine)?.value ??
    comments?.at(-1)?.value;
  if (!value) return undefined;
  const cleaned = cleanComment(value);
  if (!cleaned || cleaned.length > 500) return undefined;
  return cleaned.replaceAll("`", "");
}

function sourceText(source: string, node: AstNode): string {
  return source.slice(node.start, node.end).replace(/\r\n?/g, "\n");
}

function typeText(source: string, node: AstNode): string {
  if (!node.typeAnnotation?.typeAnnotation) return "unknown";
  const type = node.typeAnnotation.typeAnnotation;
  return sourceText(source, type);
}

function interfaceFields(
  source: string,
  tree: AstNode,
  interfaceName: string,
): FieldInfo[] {
  let declaration: AstNode | undefined;
  walk(tree, (node) => {
    if (
      !declaration &&
      node.type === "TSInterfaceDeclaration" &&
      node.id?.name === interfaceName
    ) {
      declaration = node;
    }
  });
  if (!declaration) throw new Error(`Missing interface ${interfaceName}`);
  return (declaration.body.body as AstNode[])
    .filter((node) => node.type === "TSPropertySignature")
    .map((node) => ({
      name: propertyName(node.key) ?? "unknown",
      type: typeText(source, node),
      description: fieldDescription(node, propertyName(node.key) ?? ""),
    }));
}

function interfaceLeafFields(
  source: string,
  tree: AstNode,
  interfaceName: string,
  opaqueReferences = new Set<string>(),
): FieldInfo[] {
  const declarations = new Map<string, AstNode>();
  walk(tree, (node) => {
    if (node.type === "TSInterfaceDeclaration" && node.id?.name) {
      declarations.set(node.id.name, node);
    }
  });
  const declaration = declarations.get(interfaceName);
  if (!declaration) throw new Error(`Missing interface ${interfaceName}`);

  function referencedMembers(type: AstNode): {
    members: AstNode[];
    array: boolean;
  } | undefined {
    if (type.type === "TSTypeLiteral") {
      return { members: type.members ?? [], array: false };
    }
    if (type.type === "TSArrayType") {
      const nested = referencedMembers(type.elementType);
      return nested ? { ...nested, array: true } : undefined;
    }
    if (type.type === "TSTypeReference") {
      const referenceName =
        type.typeName?.type === "Identifier" ? type.typeName.name : undefined;
      if (
        referenceName &&
        !opaqueReferences.has(referenceName) &&
        declarations.has(referenceName)
      ) {
        const reference = declarations.get(referenceName);
        if (!reference) return undefined;
        return {
          members: reference.body.body ?? [],
          array: false,
        };
      }
      const parameters =
        type.typeParameters?.params ?? type.typeArguments?.params ?? [];
      for (const parameter of parameters) {
        const nested = referencedMembers(parameter);
        if (nested) return nested;
      }
    }
    return undefined;
  }

  function expand(members: AstNode[], prefix: string, seen: Set<string>): FieldInfo[] {
    const result: FieldInfo[] = [];
    for (const node of members) {
      if (node.type !== "TSPropertySignature") continue;
      const name = propertyName(node.key);
      const type = node.typeAnnotation?.typeAnnotation;
      if (!name || !type) continue;
      const path = prefix ? `${prefix}.${name}` : name;
      const nested = referencedMembers(type);
      const cycleKey = `${path}:${sourceText(source, type)}`;
      if (nested && !seen.has(cycleKey)) {
        const nextSeen = new Set(seen).add(cycleKey);
        result.push(
          ...expand(
            nested.members,
            nested.array ? `${path}[]` : path,
            nextSeen,
          ),
        );
        continue;
      }
      result.push({
        name: path,
        type: sourceText(source, type),
        description: fieldDescription(node, name),
      });
    }
    return result;
  }

  return expand(declaration.body.body ?? [], "", new Set());
}

function humanize(value: string): string {
  return value
    .replace(/\[\]/g, "")
    .replace(/[._-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/\bRpm\b/gi, "RPM")
    .replace(/\bDrs\b/gi, "DRS")
    .replace(/\bErs\b/gi, "ERS")
    .replace(/\bAbs\b/gi, "ABS")
    .replace(/\bTc\b/gi, "TC")
    .replace(/\bFia\b/gi, "FIA")
    .replace(/\bFl\b/g, "front left")
    .replace(/\bFr\b/g, "front right")
    .replace(/\bRl\b/g, "rear left")
    .replace(/\bRr\b/g, "rear right")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (char) => char.toUpperCase());
}

function slug(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function categoryFor(name: string): string {
  const lower = humanize(name).toLowerCase();
  if (
    /^(accel|brake|clutch|handbrake|gear|steer|norm driving line|norm ai brake diff)$/.test(lower)
  ) {
    return "inputs";
  }
  if (/^position [xyz]$/.test(lower)) return "motion";
  if (
    /^race position$/.test(lower) ||
    /\b(car idx position|car idx class position|player car class position)\b/.test(lower)
  ) {
    return "race";
  }
  if (
    /\b(mem page|page fault|cpu usage|gpu usage|latency|clock skew|frame rate|channel quality|chan quality)\b/.test(
      lower,
    )
  ) {
    return "diagnostics";
  }
  if (/\b(load num textures|texture reload)\b/.test(lower)) {
    return "diagnostics";
  }
  if (
    /\b(steer|steering|clutch|handbrake|input|shifter|gear|brake raw|throttle raw)\b/.test(
      lower,
    )
  ) {
    return "inputs";
  }
  if (
    /\b(wheel load|suspension|susp|shock|spring|heave|cg height|corner weight)\b/.test(
      lower,
    )
  ) {
    return "suspension";
  }
  if (/\b(tire|tyre|wheel|compound|puddle|rumble|slip|tread)\b/.test(lower)) return "tires";
  if (/\b(damage|fault|blister|broken|wear|life)\b/.test(lower)) return "damage";
  if (/\b(setup|wing|camber|toe|anti roll|ride height|differential|spring perch)\b/.test(lower)) return "setup";
  if (/\b(load)\b/.test(lower)) return "suspension";
  if (/\b(brake|disc|pad)\b/.test(lower)) return "brakes";
  if (/\b(fuel|ers|mgu|energy|harvest|deploy|battery)\b/.test(lower)) return "fuel";
  if (/\b(engine|rpm|torque|power|boost|oil|water|exhaust|cylinder|gearbox|throttle|manifold)\b/.test(lower)) return "engine";
  if (/\b(weather|rain|air temp|air density|air pressure|track temp|road temp|wind|wet|grip|precipitation|humidity|fog|skies)\b/.test(lower)) return "weather";
  if (/\b(position|lap|sector|time|delta|distance|gap|speed trap|odometer)\b/.test(lower)) return "timing";
  if (/\b(accel|acceleration|velocity|yaw|pitch|roll|heading|orientation|rotation|force|location|speed)\b/.test(lower)) return "motion";
  if (/\b(drs|aero|diffuser|sidepod|floor|downforce)\b/.test(lower)) return "aero";
  if (/\b(tc|abs|map|limiter|assist|aid|traction control)\b/.test(lower)) return "electronics";
  if (/\b(flag|pit|race|penalty|penalties|warning|incident|status|online|wrong way|grid|caution)\b/.test(lower)) return "race";
  if (/\b(car|track|driver|class|ordinal|drivetrain|team|model|name|version|build)\b/.test(lower)) return "identity";
  if (/\b(session|packet|tick|uid|frame|replay)\b/.test(lower)) return "session";
  return "diagnostics";
}

function unitFor(name: string, type = ""): string {
  const lower = `${name} ${type}`.toLowerCase();
  const normalizedName = name.split(".").at(-1)?.toLowerCase() ?? lower;
  const exactUnits: Record<string, string> = {
    sessionuid: "text",
    israceon: "boolean",
    accel: "0–255",
    brake: "0–255",
    clutch: "0–255",
    handbrake: "0–255",
    gear: "index",
    steer: "-128–127",
    normdrivingline: "-128–127",
    normaibrakediff: "-128–127",
    boost: "psi",
    carordinal: "id",
    trackordinal: "id",
    carclass: "id",
    drivetraintype: "id",
    tyrecompound: "id",
    weathertype: "enum",
    drsactive: "boolean",
    ersstoreenergy: "J",
    ersdeployed: "J",
    ersharvested: "J",
    ersdeployedthislap: "J",
    ersharvestedthislap: "J",
    ersdeploymode: "enum",
  };
  if (exactUnits[normalizedName]) return exactUnits[normalizedName];
  if (/bool(?:ean)?/.test(type)) return "boolean";
  if (/string|char/.test(type)) return "text";
  if (/^tirewear|^tyrewear/.test(normalizedName)) return "fraction";
  if (/^wheelonrumblestrip/.test(normalizedName)) return "boolean";
  if (/^wheelinpuddledepth/.test(normalizedName)) return "fraction";
  if (/^normsuspensiontravel/.test(normalizedName)) return "ratio";
  if (/fuel.*laps.*remain|laps.*possible.*fuel/.test(lower)) return "count";
  if (/wheelrotationspeed|rotation.*speed/.test(lower)) return "rad/s";
  if (/velocity/.test(lower)) return "m/s";
  if (/force|load/.test(lower)) return "N";
  if (/speedtrap|pitspeedlimit/.test(lower)) return "km/h";
  if (/energy|harvest|deployed/.test(lower)) return "J";
  if (/(^|[^a-z])is[A-Z]|active|allowed|enabled|available/.test(name)) return "boolean";
  if (/temperature|temp/.test(lower)) return "°C";
  if (/pressurebar|oilpressure/.test(lower)) return "bar";
  if (/pressure/.test(lower)) return /brakepressure/.test(lower) ? "%" : "psi";
  if (/rpm/.test(lower)) return "rpm";
  if (/power|bhp/.test(lower)) return /bhp/.test(lower) ? "bhp" : "W";
  if (/torque/.test(lower)) return "N·m";
  if (/angle|yaw|pitch|roll|camber|toe|heading|direction/.test(lower)) return /setup/.test(lower) ? "°" : "rad";
  if (/angularvelocity|rate/.test(lower)) return "rad/s";
  if (/acceleration|gforce|accel[xyz]/.test(lower)) return "m/s²";
  if (/speed/.test(lower)) return "m/s";
  if (/time.*ms|timestampms|timems|ms$/.test(lower)) return "ms";
  if (/sessioncurrentlap|lapnumber|total.*laps/.test(lower)) return "count";
  if (/time|bestlap|lastlap|currentlap|gap|(?:best|last)s[123]/.test(lower)) return "s";
  if (/distance|travel|position[xyz]|tracklength|height|radius|defl/.test(lower)) return "m";
  if (/fuel.*percent|rainpercent|percent|bias|damage|wear|health|life/.test(lower)) return "%";
  if (/fuel|litre|liter/.test(lower)) return "L";
  if (/ratio|normalized|norm|fraction|throttle|brake|clutch|steer/.test(lower)) return "ratio";
  if (/(?:^|[.\s-])(lap|position|count|number|age|warning|incident|penalt|ordinal|id|index|sector)/.test(lower)) return "count";
  if (/\[\]|array|record|\{/.test(type)) return "structured";
  return "unitless";
}

function wheelFieldSets(fields: string[]): FieldSet[] {
  const remaining = new Set(fields);
  const sets: FieldSet[] = [];
  const patterns: [RegExp, Record<string, string>][] = [
    [/(.*)(FL|FR|RL|RR)$/, { FL: "FL", FR: "FR", RL: "RL", RR: "RR" }],
    [
      /(.*)(FrontLeft|FrontRight|RearLeft|RearRight)$/,
      {
        FrontLeft: "FL",
        FrontRight: "FR",
        RearLeft: "RL",
        RearRight: "RR",
      },
    ],
    [/(.*)M(FL|FR|RL|RR)$/, { FL: "FL", FR: "FR", RL: "RL", RR: "RR" }],
  ];

  for (const field of fields) {
    if (!remaining.has(field)) continue;
    let grouped = false;
    for (const [pattern, wheelMap] of patterns) {
      const match = field.match(pattern);
      if (!match) continue;
      const base = match[1];
      const candidates: Record<string, string> = {};
      for (const [suffix, wheel] of Object.entries(wheelMap)) {
        const candidate =
          pattern.source.startsWith("(.*)M")
            ? `${base}M${suffix}`
            : `${base}${suffix}`;
        candidates[wheel] = candidate;
      }
      if (Object.values(candidates).every((candidate) => remaining.has(candidate))) {
        const ordered = ["FL", "FR", "RL", "RR"].map((wheel) => candidates[wheel]);
        for (const candidate of ordered) remaining.delete(candidate);
        sets.push({ key: base, fields: ordered, shape: "per-wheel", wheelFields: candidates });
        grouped = true;
        break;
      }
    }
    if (!grouped && remaining.has(field)) {
      remaining.delete(field);
      sets.push({ key: field, fields: [field], shape: "scalar" });
    }
  }
  return sets;
}

function unavailable(
  reason: UnavailableLink["reason"],
  description: string,
): UnavailableLink {
  return { kind: "unavailable", reason, description };
}

function isStaticPlaceholder(node: AstNode | undefined): boolean {
  if (!node) return true;
  if (node.type === "NumericLiteral" && node.value === 0) return true;
  if (node.type === "BooleanLiteral" && node.value === false) return true;
  if (
    node.type === "UnaryExpression" &&
    node.operator === "-" &&
    node.argument?.type === "NumericLiteral" &&
    node.argument.value === 1
  ) {
    return true;
  }
  return false;
}

function memberPath(node: AstNode): string | undefined {
  const parts: string[] = [];
  let current: AstNode | undefined = node;
  while (current?.type === "MemberExpression" || current?.type === "OptionalMemberExpression") {
    const property = propertyName(current.property);
    if (!property) return undefined;
    parts.unshift(property);
    current = current.object;
  }
  if (current?.type !== "Identifier") return undefined;
  parts.unshift(current.name);
  return parts.join(".");
}
export {
  ast,
  walk,
  propertyName,
  objectProperties,
  objectCandidate,
  largestReturnObject,
  variableInitializers,
  parserOutput,
  cleanComment,
  fieldDescription,
  typeText,
  interfaceFields,
  interfaceLeafFields,
  humanize,
  slug,
  categoryFor,
  unitFor,
  wheelFieldSets,
  unavailable,
  isStaticPlaceholder,
  memberPath,
};