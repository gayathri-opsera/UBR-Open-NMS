/**
 * Names of the Node View templates (Custom UI Builder screens), by id.
 * A device's `productDefinitionId` is the id of the template its Node View is built from, so this turns it into a name.
 * One request is shared by every component on the page; a failed request leaves the map empty (the id is shown instead).
 */
import { useEffect, useState } from 'react';
import { listDescriptors } from '../../api/uiBuilder.api';

let cache: Promise<Map<string, string>> | null = null;
const load = (): Promise<Map<string, string>> => {
  if (!cache) {
    cache = listDescriptors()
      .then((all) => new Map(all.map((d) => [d.descriptorId, d.screenName] as [string, string])))
      .catch(() => { cache = null; return new Map<string, string>(); });
  }
  return cache;
};

export function useTemplateNames(): Map<string, string> {
  const [names, setNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let live = true;
    void load().then((m) => { if (live) setNames(m); });
    return () => { live = false; };
  }, []);
  return names;
}
