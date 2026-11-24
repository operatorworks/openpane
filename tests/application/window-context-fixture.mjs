export function windowContext(documentIncarnation = 'document', hostId = 'host') {
  return JSON.stringify({ role: 'main', hostId, profileId: 'profile', brokerInstance: 'broker', label: 'main', documentIncarnation, viewId: 'catalog' });
}
