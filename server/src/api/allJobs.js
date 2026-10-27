// The dashboard's All view (?view=all, user request 27 Oct 2026): the kept jobs (Job) and the left-out
// ones (NonFilteredJob) as one set. A job is in exactly one of the two, so every number and list counts
// each job once, and each All number is the Filtered one plus the Non-filtered one. Routes read a set
// through jobsFor(req) with the methods below: the part of a Mongoose model's API they use, here run on
// both collections (MongoDB $unionWith wherever results are sorted, paged or grouped).

import { Job, NonFilteredJob } from '../models.js';

const OTHER = { coll: NonFilteredJob.collection.name };

// A copy of a query filter (its arrays and plain objects; dates, regexes and ids as they are), cast the way
// find() casts one (an id or a date given as text): aggregate() doesn't cast, and casting changes what it's given.
const copy = (value) =>
  Array.isArray(value)
    ? value.map(copy)
    : value && Object.getPrototypeOf(value) === Object.prototype
      ? Object.fromEntries(Object.entries(value).map(([key, v]) => [key, copy(v)]))
      : value;
const cast = (filter) => Job.find().cast(Job, copy(filter ?? {}));

// find() and findOne() with .sort(), .skip(), .limit() and .lean() as on a Mongoose query (always lean).
function query(filter, projection, one) {
  const options = {};
  const run = async () => {
    const match = { $match: cast(filter) };
    const rows = await Job.aggregate([
      match,
      { $unionWith: { ...OTHER, pipeline: [match] } },
      ...(options.sort ? [{ $sort: options.sort }] : []),
      ...(options.skip ? [{ $skip: options.skip }] : []),
      ...(one ? [{ $limit: 1 }] : options.limit != null ? [{ $limit: options.limit }] : []),
      ...(projection ? [{ $project: projection }] : []),
    ]);
    return one ? (rows[0] ?? null) : rows;
  };
  const chain = {
    sort: (spec) => ((options.sort = spec), chain),
    skip: (n) => ((options.skip = n), chain),
    limit: (n) => ((options.limit = n), chain),
    lean: run,
    then: (resolve, reject) => run().then(resolve, reject),
  };
  return chain;
}

export const AllJobs = {
  // A pipeline that starts with $match runs that $match on each set, then the rest on both together.
  aggregate([first, ...rest]) {
    if (first?.$match) return Job.aggregate([first, { $unionWith: { ...OTHER, pipeline: [first] } }, ...rest]);
    return Job.aggregate([{ $unionWith: OTHER }, ...(first ? [first] : []), ...rest]);
  },
  find: (filter, projection) => query(filter, projection, false),
  findOne: (filter, projection) => query(filter, projection, true),
  async countDocuments(filter = {}) {
    const [kept, leftOut] = await Promise.all([Job.countDocuments(filter), NonFilteredJob.countDocuments(filter)]);
    return kept + leftOut;
  },
  async distinct(field, filter = {}) {
    const [kept, leftOut] = await Promise.all([Job.distinct(field, filter), NonFilteredJob.distinct(field, filter)]);
    return [...new Set([...kept, ...leftOut])];
  },
};
