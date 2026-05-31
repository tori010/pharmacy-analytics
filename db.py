from sqlalchemy import create_engine
from dotenv import load_dotenv
import os

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")

# Force pymysql instead of mysqlclient
import pymysql
pymysql.install_as_MySQLdb()

engine = create_engine(DATABASE_URL)