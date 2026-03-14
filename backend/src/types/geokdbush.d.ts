declare module 'geokdbush' {
  export function around(
    index: { ids: ArrayLike<number>; coords: ArrayLike<number>; nodeSize: number },
    lng: number,
    lat: number,
    maxResults?: number,
    maxDistance?: number,
    predicate?: (id: number) => boolean,
  ): number[];

  export function distance(
    lng1: number,
    lat1: number,
    lng2: number,
    lat2: number,
  ): number;
}
