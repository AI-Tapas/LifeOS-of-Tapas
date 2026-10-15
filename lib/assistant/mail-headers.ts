// Header values are validated both when queued and immediately before sending.
// Never repair CR/LF by stripping it: the owner approved a different string.
export function checkedHeader(value: string, label = "Mail header"): string {
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) {
    throw new Error(`${label} must not contain line breaks or control characters.`);
  }
  return value;
}

export function checkedAddresses(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Recipients must be a list of email addresses.");
  return value.map((item) => {
    if (typeof item !== "string") throw new Error("Every recipient must be an email address.");
    checkedHeader(item, "Email address");
    const address = item.trim();
    const parts = address.split("@");
    const [local = "", domain = ""] = parts;
    // Deliberately accept bare ASCII dot-atom mailboxes only. Display names,
    // lists, comments, quoted locals and SMTPUTF8 need an explicit UI contract.
    const valid = parts.length === 2 && address.length <= 254 && local.length <= 64 &&
      /^[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+)*$/.test(local) &&
      domain.includes(".") && domain.split(".").every((label) =>
        /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
    if (!valid) throw new Error("Use a single bare email address for each recipient.");
    return address;
  });
}

export function encodedSubject(subject: string): string {
  checkedHeader(subject, "Subject");
  // RFC 2047 encoded words, each below 75 bytes; split only at UTF-8 boundaries.
  const chunks: string[] = [];
  let chunk = "";
  for (const character of subject) {
    if (Buffer.byteLength(chunk + character, "utf8") > 42) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk || !chunks.length) chunks.push(chunk);
  return chunks.map((part) => `=?UTF-8?B?${Buffer.from(part, "utf8").toString("base64")}?=`).join("\r\n ");
}

export function plainTextMime(input: {
  from: string; to: string[]; cc: string[]; subject: string; body: string;
  // Reply threading (B36). Validated like every other header.
  inReplyTo?: string; references?: string;
}): string {
  const from = checkedAddresses([input.from])[0];
  const to = checkedAddresses(input.to);
  const cc = checkedAddresses(input.cc);
  if (!to.length) throw new Error("No recipients.");
  return [
    `From: ${from}`,
    `To: ${to.join(",\r\n ")}`,
    ...(cc.length ? [`Cc: ${cc.join(",\r\n ")}`] : []),
    `Subject: ${encodedSubject(input.subject)}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${checkedHeader(input.inReplyTo, "In-Reply-To")}`] : []),
    ...(input.references ? [`References: ${checkedHeader(input.references, "References")}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(input.body, "utf8").toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "",
    "",
  ].join("\r\n");
}
