const DEFAULT_CATEGORIES = [
  ["food", "expense", "餐饮", "餐"],
  ["transport", "expense", "交通", "行"],
  ["shopping", "expense", "购物", "购"],
  ["medical", "expense", "医疗", "医"],
  ["investment", "expense", "投资", "投"],
  ["home", "expense", "居家", "家"],
  ["fixed", "expense", "固定支出", "固"],
  ["travel", "expense", "旅行", "旅"],
  ["other", "expense", "其他", "其"],
  ["salary", "income", "工资", "薪"],
  ["bonus", "income", "奖金", "奖"],
  ["part-time", "income", "兼职", "兼"],
  ["investment-income", "income", "理财", "财"],
  ["red-packet", "income", "红包", "红"],
  ["reimbursement", "income", "报销", "报"],
  ["refund", "income", "退款", "退"],
  ["other-income", "income", "其他", "其"],
] as const;

const DEFAULT_SUBCATEGORIES: Record<string, readonly string[]> = {
  food: ["早餐", "午餐", "晚餐", "夜宵", "外卖", "咖啡", "饮料"],
  transport: ["公交", "地铁", "打车", "加油", "停车", "维修"],
  shopping: ["日用品", "服饰", "数码", "家电", "网购"],
  medical: ["药品", "门诊", "住院", "体检", "牙科"],
  investment: ["基金", "股票", "保险", "储蓄"],
  home: ["房租", "水电", "物业", "家居", "维修"],
  fixed: ["房租", "物业水电", "学费", "电话费", "会员"],
  travel: ["住宿", "交通", "门票", "餐饮", "纪念品"],
  salary: ["基本工资", "绩效", "补贴", "加班费"],
  bonus: ["年终奖", "项目奖", "提成"],
};

const MAX_D1_BOUND_PARAMETERS = 100;

type SqlValue = string | number | null;

function multiRowInsertStatements(
  database: D1Database,
  insertClause: string,
  rows: readonly (readonly SqlValue[])[],
): D1PreparedStatement[] {
  if (rows.length === 0) return [];

  const valuesPerRow = rows[0].length;
  const rowsPerStatement = Math.floor(MAX_D1_BOUND_PARAMETERS / valuesPerRow);
  const statements: D1PreparedStatement[] = [];

  for (let offset = 0; offset < rows.length; offset += rowsPerStatement) {
    const chunk = rows.slice(offset, offset + rowsPerStatement);
    const placeholders = chunk.map((row, rowIndex) => {
      const parameterOffset = rowIndex * valuesPerRow;
      return `(${row.map((_, columnIndex) => `?${parameterOffset + columnIndex + 1}`).join(", ")})`;
    }).join(", ");
    statements.push(
      database.prepare(`${insertClause} VALUES ${placeholders}`).bind(...chunk.flat()),
    );
  }

  return statements;
}

function categoryIdForLedger(ledgerId: string, slug: string): string {
  return ledgerId === "ledger-default" ? `category-${slug}` : `${ledgerId}:category-${slug}`;
}

export function defaultLedgerStatements(
  database: D1Database,
  input: { ledgerId: string; ownerUserId: string; name: string; kind: "private" | "family"; now: string },
): D1PreparedStatement[] {
  const accountId = input.ledgerId === "ledger-default" ? "account-cash" : `account-cash:${input.ledgerId}`;
  const categoryRows: SqlValue[][] = [];
  const subcategoryRows: SqlValue[][] = [];

  DEFAULT_CATEGORIES.forEach(([slug, type, name, icon], index) => {
    const categoryId = categoryIdForLedger(input.ledgerId, slug);
    categoryRows.push([
      categoryId,
      input.ledgerId,
      type,
      name,
      icon,
      index + 1,
      "active",
      1,
      input.now,
      input.now,
    ]);
    (DEFAULT_SUBCATEGORIES[slug] ?? []).forEach((subcategoryName, subcategoryIndex) => {
      subcategoryRows.push([
        `${categoryId}:subtag-${subcategoryIndex + 1}`,
        input.ledgerId,
        categoryId,
        subcategoryName,
        subcategoryIndex + 1,
        "active",
        1,
        input.now,
        input.now,
      ]);
    });
  });

  return [
    database.prepare(
      "INSERT INTO ledgers (id, owner_user_id, kind, name, base_currency, version, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'CNY', 1, ?5, ?5)",
    ).bind(input.ledgerId, input.ownerUserId, input.kind, input.name, input.now),
    database.prepare(
      "INSERT INTO ledger_members (ledger_id, user_id, role, status, version, created_at, updated_at) VALUES (?1, ?2, 'owner', 'active', 1, ?3, ?3)",
    ).bind(input.ledgerId, input.ownerUserId, input.now),
    database.prepare(
      "INSERT INTO accounts (id, ledger_id, name, type, currency, opening_balance_minor, status, version, created_at, updated_at) VALUES (?1, ?2, '现金', 'cash', 'CNY', 0, 'active', 1, ?3, ?3)",
    ).bind(accountId, input.ledgerId, input.now),
    ...multiRowInsertStatements(
      database,
      "INSERT INTO categories (id, ledger_id, type, name, icon, sort_order, status, version, created_at, updated_at)",
      categoryRows,
    ),
    ...multiRowInsertStatements(
      database,
      "INSERT INTO subcategories (id, ledger_id, category_id, name, sort_order, status, version, created_at, updated_at)",
      subcategoryRows,
    ),
  ];
}
