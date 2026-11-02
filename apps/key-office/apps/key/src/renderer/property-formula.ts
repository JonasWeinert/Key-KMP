/** Small deterministic expression interpreter; no eval, code execution or I/O. */
type Value = string | number | boolean | null;
export function evaluatePropertyFormula(
  source: string,
  properties: Record<string, unknown>,
): Value {
  if (source.length > 4096) throw Error("Formula exceeds 4,096 characters");
  const tokens: string[] = [];
  const regex =
    /\s*(\[[^\]]{1,128}\]|\{[^}]{1,128}\}|(?:\d+(?:\.\d*)?|\.\d+)|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_][A-Za-z_0-9]*|===|!==|==|!=|<=|>=|&&|\|\||[+\-*/%(),<>!])/gy;
  let at = 0;
  while (at < source.length) {
    regex.lastIndex = at;
    const m = regex.exec(source);
    if (!m) {
      if (!source.slice(at).trim()) break;
      throw Error(`Invalid formula near ${source.slice(at, at + 15)}`);
    }
    tokens.push(m[1]);
    at = regex.lastIndex;
    if (tokens.length > 512) throw Error("Formula is too complex");
  }
  let index = 0,
    depth = 0;
  const prec: Record<string, number> = {
    "||": 1,
    "&&": 2,
    "==": 3,
    "===": 3,
    "!=": 3,
    "!==": 3,
    "<": 4,
    ">": 4,
    "<=": 4,
    ">=": 4,
    "+": 5,
    "-": 5,
    "*": 6,
    "/": 6,
    "%": 6,
  };
  const number = (v: Value) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw Error("Expected a finite number");
    return n;
  };
  const apply = (op: string, a: Value, b: Value): Value => {
    switch (op) {
      case "+":
        return typeof a === "string" || typeof b === "string"
          ? String(a ?? "") + String(b ?? "")
          : number(a) + number(b);
      case "-":
        return number(a) - number(b);
      case "*":
        return number(a) * number(b);
      case "/":
        if (number(b) === 0) throw Error("Division by zero");
        return number(a) / number(b);
      case "%":
        if (number(b) === 0) throw Error("Division by zero");
        return number(a) % number(b);
      case "==":
      case "===":
        return a === b;
      case "!=":
      case "!==":
        return a !== b;
      case "<":
        return number(a) < number(b);
      case ">":
        return number(a) > number(b);
      case "<=":
        return number(a) <= number(b);
      case ">=":
        return number(a) >= number(b);
      case "&&":
        return Boolean(a) && Boolean(b);
      case "||":
        return Boolean(a) || Boolean(b);
      default:
        throw Error("Unknown operator");
    }
  };
  const expression = (minimum = 0): Value => {
    if (++depth > 32) throw Error("Formula nesting exceeds 32");
    let value: Value;
    const t = tokens[index++];
    if (!t) throw Error("Expected a value");
    if (t === "(") {
      value = expression();
      if (tokens[index++] !== ")") throw Error("Expected )");
    } else if (t === "-" || t === "+" || t === "!") {
      const rhs = expression(7);
      value = t === "!" ? !rhs : t === "-" ? -number(rhs) : number(rhs);
    } else if (t.startsWith("[") || t.startsWith("{")) {
      const name = t.slice(1, -1);
      const field = Object.prototype.hasOwnProperty.call(properties, name)
        ? name
        : Object.keys(properties).find(
            (key) => key.toLowerCase() === name.toLowerCase(),
          );
      const raw = field === undefined ? undefined : properties[field];
      if (raw === undefined) value = null;
      else if (
        raw === null ||
        ["string", "number", "boolean"].includes(typeof raw)
      )
        value = raw as Value;
      else throw Error("Formula properties must be scalar");
    } else if (/^\d|^\./.test(t)) value = Number(t);
    else if (t[0] === '"') value = JSON.parse(t);
    else if (t[0] === "'")
      value = t.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
    else if (["true", "false", "null"].includes(t))
      value = t === "null" ? null : t === "true";
    else {
      if (tokens[index++] !== "(")
        throw Error(`Use [${t}] to reference a property`);
      const args: Value[] = [];
      if (tokens[index] !== ")") {
        do {
          args.push(expression());
          if (tokens[index] !== ",") break;
          index++;
        } while (true);
      }
      if (tokens[index++] !== ")") throw Error("Expected )");
      const text = (v: Value) => String(v ?? "");
      switch (t.toLowerCase()) {
        case "concat":
          value = args.map(text).join("");
          break;
        case "lower":
          value = text(args[0]).toLowerCase();
          break;
        case "upper":
          value = text(args[0]).toUpperCase();
          break;
        case "length":
          value = [...text(args[0])].length;
          break;
        case "round":
          value = Math.round(number(args[0]));
          break;
        case "contains":
          value = text(args[0]).includes(text(args[1]));
          break;
        case "if":
          if (args.length !== 3)
            throw Error("if requires condition, true value, false value");
          value = args[0] ? args[1] : args[2];
          break;
        case "coalesce":
          value = args.find((v) => v !== null) ?? null;
          break;
        default:
          throw Error(`Unknown function ${t}`);
      }
    }
    while (index < tokens.length && (prec[tokens[index]] ?? -1) >= minimum) {
      const op = tokens[index++],
        rhs = expression(prec[op] + 1);
      value = apply(op, value, rhs);
    }
    depth--;
    if (typeof value === "string" && value.length > 65536)
      throw Error("Formula output too long");
    if (typeof value === "number" && !Number.isFinite(value))
      throw Error("Formula result is not finite");
    return value;
  };
  const result = expression();
  if (index !== tokens.length) throw Error("Unexpected trailing expression");
  return result;
}
