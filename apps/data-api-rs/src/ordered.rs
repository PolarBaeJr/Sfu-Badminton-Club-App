// A map that remembers insertion order, the way a JavaScript Map does, so the
// caches and buckets evict their oldest entry exactly as the Node service did.

use std::collections::{BTreeMap, HashMap};

pub struct OrderedMap<V> {
    entries: HashMap<String, (u64, V)>,
    order: BTreeMap<u64, String>,
    next: u64,
}

impl<V> Default for OrderedMap<V> {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            order: BTreeMap::new(),
            next: 0,
        }
    }
}

impl<V> OrderedMap<V> {
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn get(&self, key: &str) -> Option<&V> {
        self.entries.get(key).map(|(_, v)| v)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        self.entries.get_mut(key).map(|(_, v)| v)
    }

    /// `map.set`: a new key goes last, an existing key keeps its place.
    pub fn set(&mut self, key: &str, value: V) {
        if let Some((_, v)) = self.entries.get_mut(key) {
            *v = value;
            return;
        }
        let seq = self.next;
        self.next += 1;
        self.order.insert(seq, key.to_string());
        self.entries.insert(key.to_string(), (seq, value));
    }

    pub fn delete(&mut self, key: &str) -> Option<V> {
        let (seq, v) = self.entries.remove(key)?;
        self.order.remove(&seq);
        Some(v)
    }

    /// Removes the oldest entry.
    pub fn delete_oldest(&mut self) -> bool {
        let Some((_, key)) = self.order.pop_first() else {
            return false;
        };
        self.entries.remove(&key);
        true
    }
}
