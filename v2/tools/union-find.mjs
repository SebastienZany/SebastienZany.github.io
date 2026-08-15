export class DisjointSets {
  constructor(size) {
    this.parents = Uint32Array.from({ length: size }, (_, index) => index);
    this.ranks = new Uint8Array(size);
  }

  find(index) {
    let root = index;
    while (this.parents[root] !== root) root = this.parents[root];
    while (this.parents[index] !== index) {
      const parent = this.parents[index];
      this.parents[index] = root;
      index = parent;
    }
    return root;
  }

  union(left, right) {
    let leftRoot = this.find(left);
    let rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    if (this.ranks[leftRoot] < this.ranks[rightRoot]) [leftRoot, rightRoot] = [rightRoot, leftRoot];
    this.parents[rightRoot] = leftRoot;
    if (this.ranks[leftRoot] === this.ranks[rightRoot]) this.ranks[leftRoot] += 1;
  }
}
