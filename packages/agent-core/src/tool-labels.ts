const OVERRIDES: Record<string, string> = {
  search_tools:        'Searching available tools',
  read_memory:         'Reading memory',
  write_memory:        'Saving to memory',
  search_memory:       'Searching memory',
  list_memories:       'Listing memories',
  queue_approval:      'Queuing for approval',
  add_done_item:       'Recording completed action',
  add_todo:            'Adding to-do',
  complete_todo:       'Completing to-do',
  get_rental_estimate: 'Getting rental estimate',
  get_market_data:     'Fetching market data',
}

export function toolLabel(name: string): string {
  if (OVERRIDES[name]) return OVERRIDES[name]
  return name
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
}
