import redis
from rq import Worker, Queue
from app.config import REDIS_URL

if __name__ == "__main__":
    connection = redis.from_url(REDIS_URL)
    Worker([Queue("simulations", connection=connection)], connection=connection).work()
