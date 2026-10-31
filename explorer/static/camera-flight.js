// Ordinary focus moves retain the viewing angle. Overview restores a known pose.
export function flightPosition(target, offset, distance, progress, direction = null) {
  const destination = direction
    ? direction.clone().multiplyScalar(distance)
    : offset.clone().normalize().multiplyScalar(distance);
  return target.clone().add(offset.clone().lerp(destination, progress));
}
