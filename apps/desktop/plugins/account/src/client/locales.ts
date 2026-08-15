/** Copy for the account settings page. */

/** English copy. */
export const en = {
  'nav': 'Account',
  'title': 'DeepSeek API key',
  'intro': 'Create one on the DeepSeek platform and it is stored as this application\'s model credential.',
  'intro.configured': 'Opens the platform; the key you create there updates the DeepSeek model right away.',
  'state.loading': 'Reading the model credential…',
  'key.title': 'Obtained key',
  'key.show': 'Show',
  'key.hide': 'Hide',
  'state.readonly': 'This credential comes from the environment and cannot be replaced here.',
  'state.noRef': 'The DeepSeek provider is not configured to read its key from a credential reference.',
  'action.provision': 'Get an API key',
  'action.provisioning': 'Waiting…',
  'action.replace': 'Get a new key',
  'error.title': 'Something went wrong',
  'links.topUp': 'Top up',
  'links.usage': 'Usage',
  'links.billing': 'Billing',
  'links.apiKeys': 'API keys',
  'links.open': 'Open',
} as const

/** Dictionary key union for this namespace. */
export type AccountKey = keyof typeof en

/** Chinese copy. */
export const zh: Record<AccountKey, string> = {
  'nav': '账户',
  'title': 'DeepSeek API Key',
  'intro': '在 DeepSeek 开放平台创建一个，创建后自动存为本应用的模型凭据。',
  'intro.configured': '快速获得会打开平台页面，你创建的新 Key 会立即更新模型 DeepSeek。',
  'state.loading': '正在读取模型凭据…',
  'key.title': '获得的 Key',
  'key.show': '显示',
  'key.hide': '隐藏',
  'state.readonly': '该凭据来自环境变量，无法在此更换。',
  'state.noRef': 'DeepSeek provider 未配置为从凭据引用读取 Key。',
  'action.provision': '快速获得',
  'action.provisioning': '等待中…',
  'action.replace': '快速获得',
  'error.title': '出了点问题',
  'links.topUp': '充值',
  'links.usage': '用量信息',
  'links.billing': '账单',
  'links.apiKeys': 'API keys',
  'links.open': '打开',
}
