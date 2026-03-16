
## relation 代表多个短路径组成长路径

经过检索，发现 relation 多体现的是抽象概念，比如公交车路径、骑行路径等，实际上仍然由实际道路组成。因此不用管这种 relation 了

## 外形 way 组成 relation

去掉无标签的、仅组成外形的 way，常见于多个 way 组成一个大区域

## 小建筑通过 relation 组成大建筑

这个特殊处理。把 outline 或 relation 附带的信息附加到 relation 内部的每个小建筑上。（目前好像已有把 relation 信息附加的功能了，还差 outline 功能）

