/** Copy for the account settings page. */

/** English copy. */
export const en = {
  'nav': 'Account',
  'title': 'DeepSeek account',
  'intro': 'Get an API key from DeepSeek and store it as this application\'s model credential.',
  'state.loading': 'Reading the model credential…',
  'state.configured': 'The DeepSeek model has a key stored.',
  'state.configured.source': 'Supplied by: {source}',
  'state.missing': 'The DeepSeek model has no key yet.',
  'state.readonly': 'This credential comes from the environment and cannot be replaced here.',
  'state.noRef': 'The DeepSeek provider is not configured to read a key from a credential reference.',
  'balance': 'Balance {total} {currency}',
  'balance.unavailable': 'This account cannot serve requests right now.',
  'action.provision': 'Get an API key',
  'action.provisioning': 'Waiting for the key…',
  'action.provision.hint': 'Opens the official page. Sign in, create a key, and it is stored here automatically.',
  'action.replace': 'Replace the key',
  'paste.label': 'Or paste a key you already have',
  'paste.placeholder': 'sk-…',
  'paste.save': 'Check and store',
  'paste.saving': 'Checking…',
  'links.title': 'On the DeepSeek platform',
  'links.topUp': 'Top up',
  'links.topUp.hint': 'Add credit to the account.',
  'links.usage': 'Usage',
  'links.billing': 'Billing',
  'links.apiKeys': 'Manage keys',
  'notice.stored': 'The key was checked and stored. Model requests use it immediately.',
} as const

/** Dictionary key union for this namespace. */
export type AccountKey = keyof typeof en

/** Chinese copy. */
export const zh: Record<AccountKey, string> = {
  'nav': '账户',
  'title': 'DeepSeek 账户',
  'intro': '从 DeepSeek 获取 API Key，并存为本应用的模型凭据。',
  'state.loading': '正在读取模型凭据…',
  'state.configured': 'DeepSeek 模型已存有 Key。',
  'state.configured.source': '来源：{source}',
  'state.missing': 'DeepSeek 模型尚未配置 Key。',
  'state.readonly': '该凭据来自环境变量，无法在此替换。',
  'state.noRef': 'DeepSeek provider 未配置为从凭据引用读取 Key。',
  'balance': '余额 {total} {currency}',
  'balance.unavailable': '该账户当前无法服务请求。',
  'action.provision': '获取 API Key',
  'action.provisioning': '等待创建 Key…',
  'action.provision.hint': '打开官方页面。登录并创建 Key 后，会自动存入这里。',
  'action.replace': '更换 Key',
  'paste.label': '或粘贴已有的 Key',
  'paste.placeholder': 'sk-…',
  'paste.save': '校验并保存',
  'paste.saving': '校验中…',
  'links.title': '在 DeepSeek 开放平台',
  'links.topUp': '充值',
  'links.topUp.hint': '为账户增加余额。',
  'links.usage': '用量信息',
  'links.billing': '账单',
  'links.apiKeys': '管理 Key',
  'notice.stored': 'Key 已校验并保存，模型请求立即生效。',
}
