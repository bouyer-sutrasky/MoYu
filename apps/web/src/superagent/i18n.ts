/** The locale function the vendored components call, backed by the upstream dictionary. */
import { fill } from './values/text-utils';
import { zh, type DshSuperagentKey } from './client/locales';
import type { Translate } from './contract';

const dictionary: Record<string, string> = {
  ...zh,
  deploymentIntro: '配置保存到此仓库的独立实例。运行时在实例安全重启后应用修改。',
  deploymentStateDirHint: '平台为此仓库的独立实例分配状态目录，该字段只读。',
};

export const t: Translate = (key, values) => {
  const template = dictionary[key as DshSuperagentKey] ?? key;
  return values
    ? fill(
        template,
        Object.fromEntries(Object.entries(values).map(([name, value]) => [name, String(value)])),
      )
    : template;
};
