




export interface ItemRecord {
  mass: number; // 单位为 kg
  volume: number; // 单位为 m³
  length: number; // 单位为 m
  parts: []
}


interface EdibleItemRecord extends ItemRecord {

}

const templateChips = {
  parts: [
    {
      role: "surface",
      type: "wrap",
      length: 0.04,
      id: "",
    },
    {
      role: "content",
      type: "aggregate",
      mass: 0.03,
      volume: 0.08 / 1000,
      id: "",
    },
    {
      role: "content",
      type: "gas",
      id: "nitrogen",
    }
  ]
}

const templateBooks = {

}