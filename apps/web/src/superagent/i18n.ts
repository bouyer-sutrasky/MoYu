/** The locale function the vendored components call, backed by the upstream dictionary. */
import { fill } from './values/text-utils';
import { zh, type DshSuperagentKey } from './client/locales';
import type { Translate } from './contract';

const dictionary = zh as Record<string, string>;

export const t: Translate = (key, values) => {
  const template = dictionary[key as DshSuperagentKey] ?? key;
  return values
    ? fill(
        template,
        Object.fromEntries(Object.entries(values).map(([name, value]) => [name, String(value)])),
      )
    : template;
};
